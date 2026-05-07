FROM mcr.microsoft.com/playwright:v1.42.0-jammy
WORKDIR /app
COPY package.json .
RUN npm install --production
RUN npx playwright install chromium --with-deps
COPY src/ ./src/
EXPOSE 8080
CMD ["node", "src/server.js"]
