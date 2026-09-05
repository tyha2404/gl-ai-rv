module.exports = {
  apps: [
    {
      name: "gitlab-ai-reviewer",
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
