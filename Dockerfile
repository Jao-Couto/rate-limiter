FROM node:22-alpine AS build
ARG SERVICE
WORKDIR /app/services/${SERVICE}
COPY tsconfig.base.json /app/tsconfig.base.json
COPY services/${SERVICE}/package.json services/${SERVICE}/tsconfig.json ./
RUN npm install
COPY services/${SERVICE}/src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ARG SERVICE
WORKDIR /app
COPY services/${SERVICE}/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/services/${SERVICE}/dist ./dist
USER node
CMD ["node", "dist/index.js"]
