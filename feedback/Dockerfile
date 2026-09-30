FROM node:20-alpine
WORKDIR /app
COPY server.js .
# Каталог данных — заранее и владельцем node: именованный том берёт права из образа,
# иначе Docker создал бы /data от root и приёмник не смог бы писать отзывы.
RUN mkdir -p /data && chown node:node /data
ENV PORT=8787 DATA_DIR=/data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server.js"]
