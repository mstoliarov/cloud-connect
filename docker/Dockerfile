FROM node:20-alpine
WORKDIR /app
COPY proxy.js .
RUN apk add --no-cache curl
EXPOSE 11436
CMD ["node", "proxy.js"]
