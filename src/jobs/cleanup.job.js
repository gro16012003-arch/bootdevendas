const cron = require('node-cron');
const repository = require('../database/repository');
const logger = require('../config/logger');

// Função para limpar a fila e produtos
const cleanupTask = async () => {
    try {
        logger.info('Iniciando limpeza diária do banco de dados (novo dia)...');
        await repository.clearQueue();
        logger.info('Banco de dados limpo com sucesso! Pronto para novas ofertas.');
    } catch (error) {
        logger.error('Erro ao realizar limpeza diária:', error);
    }
};

// Agenda para rodar todo dia às 22:00 Horário de Brasília (01:00 UTC no Render)
const startCleanupJob = () => {
    cron.schedule('0 1 * * *', cleanupTask);
    logger.info('Job de limpeza diária agendado para 22:00 BRT (01:00 UTC).');
};

module.exports = {
    startCleanupJob,
    cleanupTask
};
