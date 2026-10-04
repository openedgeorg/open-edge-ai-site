FROM nginx:1.27-alpine
COPY infra/runtime/web.conf /etc/nginx/conf.d/default.conf
COPY site /usr/share/nginx/html
# Static packaging skeleton. It does not terminate public TLS and it does not claim Gate 1.
EXPOSE 8080
