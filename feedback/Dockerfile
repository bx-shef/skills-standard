FROM node:20-alpine
WORKDIR /app
COPY server.js .
ENV PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.js"]
