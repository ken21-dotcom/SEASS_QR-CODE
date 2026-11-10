const path = require('path');

const projectRoot = __dirname;

module.exports = {
  apps: [
    {
      name: 'attendly-frontend',
      cwd: projectRoot,
      script: path.join(projectRoot, 'node_modules', 'http-server', 'bin', 'http-server'),
      interpreter: 'node',
      args: '-p 5173 -c-1',
      env: {
        NODE_ENV: 'development'
      }
    }
  ]
};
