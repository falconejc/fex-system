module.exports = {
  apps: [
    {
      name: 'frango-system',
      script: 'server.js',
      cwd: '/opt/frango-system',
      env: {
        PORT: 3000,
        APP_ENV: 'production',
        DB_FILE: 'frango.db'
      }
    },
    {
      name: 'frango-system-test',
      script: 'server.js',
      cwd: '/opt/frango-system',
      env: {
        PORT: 3001,
        APP_ENV: 'test',
        DB_FILE: 'frango-test.db'
      }
    }
  ]
};
