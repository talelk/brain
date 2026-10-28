FROM python:3.12-alpine
RUN apk add --no-cache bash
WORKDIR /tmp
CMD ["sleep", "infinity"]
