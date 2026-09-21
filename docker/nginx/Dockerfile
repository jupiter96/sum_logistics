# alpine is more secure
FROM nginx:stable-alpine

ENV NGINX_APPLICATION_HOSTNAME application

COPY docker/nginx/vhost.conf /etc/nginx/templates/default.conf.template
COPY backend/public/ /sum_logistics/api/public/