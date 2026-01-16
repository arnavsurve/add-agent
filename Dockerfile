FROM node:20-slim

# Install git (required for cloning repos)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install OpenCode CLI globally (required by the SDK's embedded server mode)
RUN npm install -g opencode-ai

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Run the agent via bootstrap (patches fetch before loading main code)
CMD ["node", "dist/bootstrap.js"]
