FROM openjdk:12-alpine

WORKDIR /app

RUN apk add --update nodejs nodejs-npm imagemagick pngquant curl ghostscript-fonts

RUN curl -Lk https://github.com/Minecraft-Technik-Wiki/BlockMap/releases/download/1.6.1/BlockMap-cli-1.6.1.jar -o blockmap.jar
COPY . .
RUN npm install --global

ENTRYPOINT [ "tile-compiler", "-j", "blockmap.jar", "-o", "/tiles"]
CMD []
