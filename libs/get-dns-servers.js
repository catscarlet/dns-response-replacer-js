const os = require('os');
const { exec } = require('child_process');
const fs = require('fs').promises;

/**
 * 获取当前操作系统的DNS服务器信息
 * @returns {Promise<Array<string>>} DNS服务器地址数组
 */
async function getDnsServers() {
    const platform = os.platform();

    if (platform === 'win32') {
        // Windows系统: 通过ipconfig /all命令获取
        return new Promise((resolve, reject) => {
            exec('ipconfig /all', (error, stdout) => {
                if (error) {
                    return reject(error);
                }

                const dnsServers = [];
                const lines = stdout.split('\n');
                let inDnsSection = false;

                // 解析ipconfig输出，提取DNS服务器信息
                for (const line of lines) {
                    const trimmedLine = line.trim();

                    // 查找包含DNS服务器的部分
                    if (trimmedLine.startsWith('DNS服务器')) {
                        inDnsSection = true;
                        // 提取第一个DNS服务器
                        const firstDns = trimmedLine.split(':')[1]?.trim();
                        if (firstDns) {
                            dnsServers.push(firstDns);
                        }
                    }
                    // 后续行可能包含更多DNS服务器
                    else if (inDnsSection && trimmedLine && !trimmedLine.includes(':')) {
                        dnsServers.push(trimmedLine);
                    }
                    // 遇到其他网络信息部分则停止
                    else if (inDnsSection && trimmedLine.includes(':')) {
                        inDnsSection = false;
                    }
                }

                resolve(dnsServers);
            });
        });
    }
    else if (platform === 'linux') {
        // Linux系统: 从/resolv.conf文件读取
        try {
            const content = await fs.readFile('/etc/resolv.conf', 'utf8');
            const lines = content.split('\n');
            const dnsServers = [];

            // 解析resolv.conf，提取nameserver条目
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine.startsWith('nameserver')) {
                    const dns = trimmedLine.split(' ')[1];
                    if (dns) {
                        dnsServers.push(dns);
                    }
                }
            }

            return dnsServers;
        } catch (error) {
            throw new Error(`无法读取Linux DNS配置: ${error.message}`);
        }
    }
    else {
        throw new Error(`不支持的操作系统: ${platform}`);
    }
}

/**
 * 获取DNS服务器信息并以JSON格式输出
 * @returns {Promise<string>} JSON格式的DNS服务器信息
 */
async function getDnsServersJson() {
    try {
        const dnsServers = await getDnsServers();
        return JSON.stringify({
            platform: os.platform(),
            dnsServers: dnsServers
        }, null, 2);
    } catch (error) {
        return JSON.stringify({
            error: error.message
        }, null, 2);
    }
}

// 导出模块方法
module.exports = {
    getDnsServers,
    getDnsServersJson
};

// 如果直接运行此脚本，则输出结果
if (require.main === module) {
    (async () => {
        console.log(await getDnsServersJson());
    })();
}
