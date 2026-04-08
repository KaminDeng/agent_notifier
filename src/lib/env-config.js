/**
 * 环境变量配置管理模块
 * 统一处理所有环境变量的加载和配置
 */

const fs = require('fs');
const path = require('path');

/**
 * 环境变量配置类
 */
class EnvConfig {
    constructor() {
        this.loadEnvironmentVariables();
    }

    /**
     * 加载环境变量
     * 根据脚本所在位置加载 .env 文件
     */
    loadEnvironmentVariables() {
        try {
            // 加载项目根目录的 .env 文件
            const envPath = path.join(__dirname, '..', '.env');

            if (fs.existsSync(envPath)) {
                require('dotenv').config({ path: envPath });
                console.log('✅ 环境变量加载成功');
            } else {
                console.log('⚠️  .env 文件不存在，使用系统环境变量');
                require('dotenv').config();
            }
        } catch (error) {
            console.log('❌ 环境变量加载失败:', error.message);
        }
    }

    /**
     * 获取飞书自建应用配置（双向通信）
     */
    getFeishuAppConfig() {
        return {
            app_id: process.env.FEISHU_APP_ID || '',
            app_secret: process.env.FEISHU_APP_SECRET || '',
            chat_id: process.env.FEISHU_CHAT_ID || '',
            enabled: !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET)
        };
    }

    /**
     * 获取声音通知配置
     */
    getSoundConfig() {
        return {
            enabled: process.env.SOUND_ENABLED !== 'false',
            backup: true
        };
    }

    /**
     * 获取通用通知配置
     */
    getNotificationConfig() {
        return {
            enabled: process.env.NOTIFICATION_ENABLED !== 'false'
        };
    }

    /**
     * 获取所有配置
     */
    getAllConfig() {
        return {
            feishu_app: this.getFeishuAppConfig(),
            sound: this.getSoundConfig(),
            notification: this.getNotificationConfig()
        };
    }
}

// 导出单例实例
const envConfig = new EnvConfig();

module.exports = {
    EnvConfig,
    envConfig
};