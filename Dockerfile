FROM node:22-alpine
WORKDIR /app
COPY package.json server.js plc.js tls-cert.js ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
USER node
CMD ["node", "server.js"]
