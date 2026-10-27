FROM node:22-alpine
WORKDIR /app
# ffmpeg：浏览器不支持的音视频实时转码、HEIC/TIFF 图片转换
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir -p /data/local
VOLUME /data
EXPOSE 8080
CMD ["node", "src/server.js"]
