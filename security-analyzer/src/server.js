const app = require('./app');
const { PORT } = require('./config/constants');
const stateService = require('./services/state.service');
const pollService = require('./services/poll.service');
const logger = require('./utils/logger');

const server = app.listen(PORT, () => {
  logger.info(`server listening on http://localhost:${PORT}`);
  pollService.startPolling();
});

function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down...`);
  try { pollService.stopPolling(); } catch (e) { /* best effort */ }
  try { stateService.shutdown(); } catch (e) { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', err);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err);
});
