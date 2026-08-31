FROM nginx:1.27-alpine
COPY . /usr/share/nginx/html
COPY server/nginx-default.conf /etc/nginx/conf.d/default.conf
