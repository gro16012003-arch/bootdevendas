// Importações leves para o boot inicial
const app = require('./app');
const env = require('./config/env');
const logger = require('./config/logger');

// Lazy-loading de funções pesadas
const getInitDB = () => require('./database/init').initializeDB;
const getWhatsapp = () => require('./publishers/whatsapp.publisher');
const getJobs = () => ({
    startCaptureJob: require('./jobs/capture.job').startCaptureJob,
    startPublishJob: require('./jobs/publisher.job').startPublishJob,
    startCleanupJob: require('./jobs/cleanup.job').startCleanupJob
});

// Proteção contra erros fatais não tratados
process.on('unhandledRejection', (reason) => {
    const errorMsg = reason instanceof Error ? reason.stack : String(reason);
    logger.error(`Unhandled Rejection: ${errorMsg}`);
});
process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err.stack || err.message}`);
});

const startServer = async () => {
    logger.info('🚀 Iniciando Boot...');

    // ✅ PASSO 1: Servidor web sobe PRIMEIRO — porta sempre aberta para o Render
    await new Promise((resolve, reject) => {
        const server = app.listen(env.port, '0.0.0.0', () => {
            logger.info(`🌐 Servidor Web ativo na porta ${env.port}`);
            resolve();
        }).on('error', reject);
        
        // Evita erro 502 Bad Gateway no Render
        server.keepAliveTimeout = 120000;
        server.headersTimeout = 120000;
    });

        // Pequena pausa para estabilizar
        await new Promise(resolve => setTimeout(resolve, 5000));

        // ✅ FASE 2: Banco de Dados Neon
        logger.info('🐘 FASE 2: Conectando ao Banco de Dados...');
        const initializeDB = getInitDB();
        await initializeDB();
        logger.info('✅ Banco de Dados pronto.');

        // Pausa de 20 segundos para o Garbage Collector limpar a memória do boot do DB
        logger.info('⏳ Aguardando 20s para estabilizar memória...');
        await new Promise(resolve => setTimeout(resolve, 20000));

        // ✅ FASE 3: WhatsApp Publisher
        logger.info('📱 FASE 3: Iniciando WhatsApp...');
        const whatsappPublisher = getWhatsapp();
        whatsappPublisher.initialize().catch(err => {
            logger.error('⚠️ Falha ao iniciar WhatsApp:', err.message);
        });

        // Pausa de mais 30 segundos antes de começar a pesada tarefa de captura
        logger.info('⏳ Aguardando 30s antes de ativar automações...');
        await new Promise(resolve => setTimeout(resolve, 30000));

        // ✅ FASE 4: Agendamento de Jobs
        logger.info('⚙️ FASE 4: Ativando Jobs de Automação...');
        const { startCaptureJob, startPublishJob, startCleanupJob } = getJobs();
        startCleanupJob();
        startCaptureJob();
        startPublishJob();
        
        logger.info('🚀 Boot concluído com sucesso!');

    } catch (fatalError) {
        logger.error('❌ FALHA CRÍTICA NO BOOT:', fatalError.message);
        process.exit(1);
    }
};

startServer().catch(err => {
    logger.error(`❌ FALHA FATAL NO BOOT: ${err.stack || err.message || err}`);
    process.exit(1);
});
