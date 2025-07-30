const dgram = require('dgram');
const dnsPacket = require('dns-packet');
const {promisify} = require('util');
const net = require('net');

const fs = require('fs');
const path = require('path');

let replacedCache = loadReplacedCache();

const cloudflareIpv4List = getCloudflareIpv4List();

const cloudflareIpv6List = getCloudflareIpv6List();

const upstreamServers = getUpstreamServers();

const cloudflareIpv4CfstList = getCloudflareIpv4CfstList();
const cloudflareIpv6CfstList = getCloudflareIpv6CfstList();

const CONFIG = {
    port: 53,
    host: '0.0.0.0',
    timeout: 5000,
    retryCount: 2,
};

CONFIG.upstreamServers = upstreamServers;

const udpServer = dgram.createSocket('udp4');

const RECORD_TYPES = {
    1: 'A',
    28: 'AAAA',
    5: 'CNAME',
    15: 'MX',
    2: 'NS',
    12: 'PTR',
    33: 'SRV',
    6: 'SOA',
    16: 'TXT',
    257: 'CAA',
    43: 'DS',
    48: 'DNSKEY',
};

function getContentFromListFile(filepath) {
    try {
        const content = fs.readFileSync(filepath, 'utf8');

        const lines = content.split(/\r?\n/);

        let result = [];
        lines.forEach((line, i) => {
            if (line != '' && line.startsWith('#') == false) {
                result.push(line);
            }
        });

        if (result.length == 0) {
            console.error('\x1b[41m' + '错误： ' + '\x1b[0m' + '\x1b[31m' + filepath + '\x1b[0m' + '\x1b[41m' + ' 文件为空' + '\x1b[0m');
            process.exit(0);
        }

        return result;
    } catch (err) {
        console.error('读取文件时发生错误：', err.message);
    }
}

function getCloudflareIpv4List() {
    const result = getContentFromListFile('cloudflare-ipv4-list.list');
    console.log('get cloudflareIpv4List: ' + result.length);
    console.log(result);
    return result;
};

function getCloudflareIpv6List() {
    const result = getContentFromListFile('cloudflare-ipv6-list.list');
    console.log('get cloudflareIpv6List: ' + result.length);
    console.log(result);
    return result;
};

function getUpstreamServers() {
    const serverlist = getContentFromListFile('dns-servers.list');

    let nameservers = [];
    serverlist.forEach((item, i) => {

        if (ipToInt(item) !== null) {
            let serverItem = {
                host: item,
                port: 53,
            };
            nameservers.push(serverItem);
        }

    });

    console.log('get UpstreamServers: ' + nameservers.length);
    console.log(nameservers);
    return nameservers;

};

function getCloudflareIpv4CfstList() {
    const list = getContentFromListFile('cloudflare-ipv4-cfst-list.list');

    let result = [];

    list.forEach((item, i) => {
        if (ipToInt(item) !== null) {
            result.push(item);
        }
    });

    console.log('cloudflareIpv4CfstList: ' + result.length);
    console.log(result);
    return result;
}

function getCloudflareIpv6CfstList() {
    const list = getContentFromListFile('cloudflare-ipv6-cfst-list.list');

    let result = [];

    list.forEach((item, i) => {
        if (ipv6ToBinary(item) !== null) {
            result.push(item);
        }
    });

    console.log('cloudflareIpv6CfstList: ' + result.length);
    console.log(result);
    return result;
}

console.log(CONFIG);

function forwardDnsRequestUdp(packet, upstream) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        const buffer = dnsPacket.encode(packet);

        const timeoutId = setTimeout(() => {
            socket.close();
            reject(new Error(`Timeout querying ${upstream.host}:${upstream.port}`));
        }, CONFIG.timeout);

        socket.send(buffer, 0, buffer.length, upstream.port, upstream.host, (err) => {
            if (err) {
                clearTimeout(timeoutId);
                socket.close();
                reject(err);
            }
        });

        socket.on('message', (responseBuffer) => {
            clearTimeout(timeoutId);
            try {
                const response = dnsPacket.decode(responseBuffer);
                response.upstream = upstream;
                socket.close();
                resolve(response);
            } catch (err) {
                socket.close();
                reject(err);
            }
        });

        socket.on('error', (err) => {
            clearTimeout(timeoutId);
            socket.close();
            reject(err);
        });
    });
};

async function handleUdpQuery(message, rinfo) {
    try {
        const request = dnsPacket.decode(message);

        if (request.questions && request.questions.length > 0) {
            const question = request.questions[0];
            const type = RECORD_TYPES[question.type] || question.type;

            //console.log(`[QUERY] ${question.name} (${type}) from ${rinfo.address}:${rinfo.port}`);
        }

        let response;
        let lastError;

        for (let i = 0; i < CONFIG.upstreamServers.length; i++) {
            const upstream = CONFIG.upstreamServers[i];

            try {
                response = await forwardDnsRequestUdp(request, upstream);
                lastError = null;
                break;
            } catch (err) {
                lastError = err;
                console.error(`[UDP UPSTREAM ERROR] ${upstream.host}:${upstream.port} - ${err.message}`);

                for (let retry = 0; retry < CONFIG.retryCount; retry++) {
                    try {
                        console.log(`[RETRY] ${retry + 1}/${CONFIG.retryCount} to ${upstream.host}:${upstream.port}`);
                        response = await forwardDnsRequestUdp(request, upstream);
                        lastError = null;
                        break;
                    } catch (retryErr) {
                        lastError = retryErr;
                    }
                }

                if (response) {
                    break;
                }
            }
        }

        if (!response && lastError) {
            throw lastError;
        }

        let newAnswers = [];
        let newCache = false;
        let name = response.questions[0].name;
        let type = response.questions[0].type;

        for (let i = 0; i < response.answers.length; i++) {
            let answer = response.answers[i];
            if (answer.type == 'A') {
                if (Object.hasOwn(replacedCache.A, name)) {
                    let cache = replacedCache.A[name];

                    newAnswers = cache.answers;
                    break;
                }

                let isCloudflareIPv4IP = isIpInSet(answer.data, cloudflareIpv4List);

                if (isCloudflareIPv4IP) {
                    let tmp = cloudflareIpv4CfstList;
                    let newData = [];
                    if (cloudflareIpv4CfstList.length > 2) {
                        for (let i = cloudflareIpv4CfstList.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));

                            [tmp[i], tmp[j]] = [tmp[j], tmp[i]];
                        }
                        newData = tmp.slice(0, 2);
                    } else {
                        newData = tmp;
                    }

                    newData.forEach((item, i) => {
                        let newAnswer = {
                            name: name,
                            type: 'A',
                            ttl: 300,
                            class: 'IN',
                            flush: false,
                            data: item,
                        };

                        newAnswers.push(newAnswer);
                    });

                    newCache = true;
                    break;
                } else {
                    //console.log(answer.data + ' is not a CloudflareIPv4IP');
                }
            } else if (answer.type == 'AAAA') {
                if (Object.hasOwn(replacedCache.AAAA, name)) {
                    let cache = replacedCache.AAAA[name];

                    newAnswers = cache.answers;
                    break;
                }

                let isCloudflareIPv6IP = isIpv6InSet(answer.data, cloudflareIpv6List);

                if (isCloudflareIPv6IP) {
                    let tmp = cloudflareIpv6CfstList;
                    for (let i = cloudflareIpv6CfstList.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));

                        [tmp[i], tmp[j]] = [tmp[j], tmp[i]];
                    }
                    let newData = tmp.slice(0, 2);

                    newData.forEach((item, i) => {
                        let newAnswer = {
                            name: name,
                            type: 'AAAA',
                            ttl: 300,
                            class: 'IN',
                            flush: false,
                            data: item,
                        };

                        newAnswers.push(newAnswer);
                    });

                    newCache = true;

                    break;
                } else {
                    //console.log(answer.data + ' is not a CloudflareIPv6IP');
                }
            } else {
                //console.log('type not relevent');
            }
        }

        if (newAnswers.length > 0) {
            let tempAnswers = response.answers;
            response.answers = newAnswers;
            response.originalAnswers = tempAnswers;

            if (newCache) {
                console.log('saving ' + type + ' cache for: ' + '\x1b[32m' + name + '\x1b[0m' + ', return ' + '\x1b[36m' + 'replaced' + '\x1b[0m' + ' answer: ' + '\x1b[32m' + JSON.stringify(response.answers) + '\x1b[0m' + ' to ' + '\x1b[35m' + rinfo.address + '\x1b[0m');
                saveReplacedCache(type, name, newAnswers);
            } else {
                console.log('hit ' + type + ' cache: ' + '\x1b[32m' + name + '\x1b[0m' + ', return ' + '\x1b[34m' + 'cached' + '\x1b[0m' + ' answer: ' + '\x1b[32m' + JSON.stringify(response.answers) + '\x1b[0m' + ' to ' + '\x1b[35m' + rinfo.address + '\x1b[0m');
            }
        } else {
            console.log('not a cloudflare ' + type + ' query: ' + '\x1b[32m' + name + '\x1b[0m' + ', return original answer from upstream: ' + '\x1b[33m' + response.upstream.host + '\x1b[0m' + ' to ' + '\x1b[35m' + rinfo.address + '\x1b[0m');
        }

        const responseBuffer = dnsPacket.encode(response);

        udpServer.send(responseBuffer, 0, responseBuffer.length, rinfo.port, rinfo.address, (err) => {
            if (err) {
                console.error(`[SEND ERROR] ${err.message}`);
            } else if (response.answers && response.answers.length > 0) {
                //console.log(`[RESPONSE] Sent ${response.answers.length} answers to ${rinfo.address}:${rinfo.port}`);
                //console.log('--------------------------------------------');
            }
        });

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);

        /*
        const errorResponse = {
            type: 'response',
            id: dnsPacket.decode(message).id,
            flags: dnsPacket.RESPONSE | dnsPacket.AUTHORITATIVE | dnsPacket.RCODE.NXDOMAIN,
            questions: dnsPacket.decode(message).questions || [],
        };

        const errorBuffer = dnsPacket.encode(errorResponse);
        udpServer.send(errorBuffer, 0, errorBuffer.length, rinfo.port, rinfo.address);
        */
    }
};

function ipToInt(ip) {
    const octets = ip.split('.');
    if (octets.length !== 4) {return null;}

    let result = 0;
    for (let i = 0; i < 4; i++) {
        const octet = parseInt(octets[i], 10);
        if (isNaN(octet) || octet < 0 || octet > 255) {
            return null;
        }
        result = (result << 8) | octet;
    }
    return result >>> 0;
}

function isIpInCidr(ip, cidr) {
    const [cidrIp, prefixLength] = cidr.split('/');
    if (!prefixLength || prefixLength < 0 || prefixLength > 32) {
        return false;
    }

    const ipInt = ipToInt(ip);
    const cidrIpInt = ipToInt(cidrIp);

    if (ipInt === null || cidrIpInt === null) {
        return false;
    }

    const mask = prefixLength === 0 ? 0 : 0xFFFFFFFF << (32 - prefixLength);
    const network = cidrIpInt & mask;
    return (ipInt & mask) === network;
}

function isIpInSet(ip, ipset) {
    if (ipToInt(ip) === null) {
        return false;
    }

    for (const entry of ipset) {
        if (entry.includes('/')) {
            if (isIpInCidr(ip, entry)) {
                return true;
            }
        } else {
            if (ip === entry) {
                return true;
            }
        }
    }

    return false;
}

function ipv6ToBinary(ipv6) {
    let parts = ipv6.split('::');
    let left = parts[0].split(':').filter(p => p !== '');
    let right = parts.length > 1 ? parts[1].split(':').filter(p => p !== '') : [];
    let totalParts = left.length + right.length;

    if (parts.length > 2 || totalParts > 8) {
        return null;
    }

    let fullParts = [...left];
    for (let i = 0; i < 8 - totalParts; i++) {
        fullParts.push('0');
    }
    fullParts.push(...right);

    let binary = '';
    for (let part of fullParts) {
        if (part.length > 4) {return null;}
        let hex = part.padStart(4, '0');
        let bin = parseInt(hex, 16).toString(2).padStart(16, '0');
        binary += bin;
    }

    return binary.length === 128 ? binary : null;
}

function isIpv6InCidr(ipv6, cidr) {
    let [cidrIp, prefix] = cidr.split('/');
    if (!prefix || isNaN(prefix) || prefix < 0 || prefix > 128) {
        return false;
    }

    let ipBinary = ipv6ToBinary(ipv6);
    let cidrBinary = ipv6ToBinary(cidrIp);

    if (!ipBinary || !cidrBinary) {
        return false;
    }

    return ipBinary.substring(0, prefix) === cidrBinary.substring(0, prefix);
}

function isIpv6InSet(ipv6, ipset) {
    if (!ipv6ToBinary(ipv6)) {
        throw new Error('无效的IPv6地址');
    }

    for (let entry of ipset) {
        if (entry.includes('/')) {
            if (isIpv6InCidr(ipv6, entry)) {
                return true;
            }
        } else {
            let ipBinary = ipv6ToBinary(ipv6);
            let entryBinary = ipv6ToBinary(entry);
            if (ipBinary && entryBinary && ipBinary === entryBinary) {
                return true;
            }
        }
    }

    return false;
}

function saveReplacedCache(type, name, data) {
    replacedCache[type][name] = {};
    replacedCache[type][name].answers = data;
    replacedCache[type][name].timestamp = Math.floor(Date.now() / 1000);

    const filePath = path.join(__dirname + '/cache', 'cache.json');

    try {
        let json = JSON.stringify(replacedCache, null, '    ');
        const options = {
            encoding: 'utf8',
            mode: 0o777,
        };
        fs.writeFileSync(filePath, json, options);

    } catch (err) {
        console.error('写入文件时发生错误：', err.message);
    }
}

function loadReplacedCache() {
    const cachePath = __dirname + '/cache';

    try {
        fs.accessSync(cachePath, constants.F_OK);
    } catch (err) {
        console.error('cachePath not exist, creating: ' + cachePath);
        try {
            fs.mkdirSync(cachePath, {
                recursive: true,
                mode: 0o777,
            });

            fs.chmodSync(cachePath, 0o777);
        } catch (mkdirErr) {
            console.error('Failed to create cache directory:', mkdirErr);
            throw mkdirErr;
        }
    }

    const filePath = path.join(__dirname + '/cache', 'cache.json');

    if (!fs.existsSync(filePath)) {
        console.log('Cache file not exists. Load empty cache');
        let replacedCache = {
            A: {},
            AAAA: {},
        };

        console.log(replacedCache);
        return replacedCache;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8');
        console.log('Load cache files.');
        const json = JSON.parse(content);

        let cacheIpv4count = Object.keys(json.A).length;
        let cacheIpv6count = Object.keys(json.AAAA).length;

        console.log('IPV4 cache count: ' + cacheIpv4count);
        console.log('IPV6 cache count: ' + cacheIpv6count);

        return json;
    } catch (err) {
        console.error('读取文件时发生错误：', err.message);
    }
}

udpServer.on('message', handleUdpQuery);

udpServer.on('listening', () => {
    const address = udpServer.address();
    console.log(`DNS over UDP Server listening on ${address.address}:${address.port}`);
    console.log(`Upstream DNS servers: ${CONFIG.upstreamServers.map(s => `${s.host}:${s.port}`).join(', ')}`);
    console.log('Supported record types:', Object.values(RECORD_TYPES).join(', '));
});

udpServer.on('error', (err) => {
    console.error(`udpServer error: ${err.message}`);
    udpServer.close();
});

udpServer.bind(CONFIG.port, CONFIG.host);

process.on('SIGINT', () => {
    console.log('Shutting down DNS udpServer...');
    udpServer.close(() => {
        console.log('DNS udpServer stopped');
        process.exit(0);
    });
});

const tcpServer = net.createServer((tcpSocket) => {
    const clientAddress = `${tcpSocket.remoteAddress}:${tcpSocket.remotePort}`;

    let buffer = Buffer.alloc(0);

    tcpSocket.on('data', (data) => {
        buffer = Buffer.concat([buffer, data]);

        // DNS over TCP的消息前有2字节表示长度
        while (buffer.length >= 2) {
            const length = buffer.readUInt16BE(0);

            if (buffer.length >= length + 2) {
                const message = buffer.slice(2, length + 2);
                buffer = buffer.slice(length + 2);

                // 处理DNS请求
                handleTcpQuery(message, tcpSocket, clientAddress);
            } else {
                // 数据不完整，等待更多数据
                break;
            }
        }
    });

    tcpSocket.on('end', () => {
    });

    tcpSocket.on('error', (err) => {
        console.error(`[TCP] 连接 ${clientAddress} 错误:`, err);
    });
});

async function handleTcpQuery(message, tcpSocket, clientAddress) {
    try {
        const request = dnsPacket.decode(message);
        let response;
        let lastError;
        for (let i = 0; i < CONFIG.upstreamServers.length; i++) {
            const upstream = CONFIG.upstreamServers[i];

            try {
                response = await forwardDnsRequestTcp(request, upstream);
                lastError = null;
                break;
            } catch (err) {
                lastError = err;
                console.error(`[TCP UPSTREAM ERROR] ${upstream.host}:${upstream.port} - ${err.message}`);

                for (let retry = 0; retry < CONFIG.retryCount; retry++) {
                    try {
                        console.log(`[RETRY] ${retry + 1}/${CONFIG.retryCount} to ${upstream.host}:${upstream.port}`);
                        response = await forwardDnsRequestUdp(request, upstream);
                        lastError = null;
                        break;
                    } catch (retryErr) {
                        lastError = retryErr;
                    }
                }

                if (response) {
                    break;
                }
            }
        }

        // DNS over TCP的响应前需要添加2字节的长度
        const lengthBuffer = Buffer.alloc(2);
        lengthBuffer.writeUInt16BE(response.length, 0);
        const responseWithLength = Buffer.concat([lengthBuffer, response]);

        tcpSocket.write(responseWithLength, () => {
        });
    } catch (err) {
        console.error(`[TCP] 处理 ${clientAddress} 请求错误:`, err);
        tcpSocket.end();
    }
}

function forwardDnsRequestTcp(request, upstream) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(upstream, () => {
            const requestBuffer = dnsPacket.encode(request);

            // DNS over TCP的请求前需要添加2字节的长度
            const lengthBuffer = Buffer.alloc(2);
            lengthBuffer.writeUInt16BE(requestBuffer.length, 0);
            const requestWithLength = Buffer.concat([lengthBuffer, requestBuffer]);

            socket.write(requestWithLength);
        });

        let buffer = Buffer.alloc(0);

        socket.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);

            // 检查是否接收到完整的响应
            while (buffer.length >= 2) {
                const length = buffer.readUInt16BE(0);

                if (buffer.length >= length + 2) {
                    const responseBuffer = buffer.slice(2, length + 2);
                    socket.destroy();
                    resolve(responseBuffer);
                    return;
                } else {
                    // 数据不完整，等待更多数据
                    break;
                }
            }
        });

        socket.on('error', (err) => {
            reject(err);
        });

        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error('DNS请求超时 (TCP)'));
        });

        socket.setTimeout(CONFIG.timeout);
    });
}


tcpServer.listen(CONFIG.port, () => {
    console.log(`DNS over TCP Server listening on ${CONFIG.port}`);
});

tcpServer.on('error', (err) => {
    console.error(`[TCP] 服务器错误:`, err);
    tcpServer.close();
});
