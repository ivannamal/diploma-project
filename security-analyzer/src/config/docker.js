const C = require('./constants');

// persistent npm cache volume
const NPM_CACHE_VOLUME = process.env.ANALYZER_NPM_CACHE_VOLUME || 'analyzer_npm_cache';
const WORK_TMPFS_SIZE = process.env.ANALYZER_WORK_TMPFS_SIZE || '2g';
const TMP_TMPFS_SIZE = process.env.ANALYZER_TMP_TMPFS_SIZE || '256m';
const MEMORY_LIMIT = process.env.ANALYZER_MEMORY_LIMIT || '2g';

function buildRunArgs({ image, repoPath, name, command, network = 'bridge' }) {
  return [
    'run',
    '--rm',
    '--name', name,
    '--read-only',

    '--tmpfs', `/tmp:rw,exec,size=${TMP_TMPFS_SIZE}`,
    '--tmpfs', `/work:rw,exec,size=${WORK_TMPFS_SIZE}`,

    '--memory', MEMORY_LIMIT,
    '--cpus', C.DOCKER_CPUS,
    '--pids-limit', C.DOCKER_PIDS,
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--network', network,

    '-e', 'HOME=/tmp',
    '-e', 'NPM_CONFIG_CACHE=/npm-cache',
    '-e', 'NPM_CONFIG_PREFER_OFFLINE=true',
    '-e', 'NPM_CONFIG_UPDATE_NOTIFIER=false',

    '-v', `${repoPath}:/repo:ro`,
    '-v', `${NPM_CACHE_VOLUME}:/npm-cache`,
    '-w', '/work',
    image,
    'sh', '-c', command,
  ];
}

module.exports = { buildRunArgs, NPM_CACHE_VOLUME };
