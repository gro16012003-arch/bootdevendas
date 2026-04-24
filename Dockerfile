FROM node:20-slim

# Dependências para o SQLite
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Permissões na pasta local
RUN mkdir -p .baileys_auth && chmod 777 .baileys_auth

EXPOSE 3000

CMD [ "node", "src/server.js" ]
