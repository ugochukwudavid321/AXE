# Use the official Node.js LTS slim image as the base
FROM node:lts-slim

# Update package lists, install Ghostscript, and clean up to keep the image size small
RUN apt-get update && \
apt-get install -y ghostscript && \
apt-get clean && \
rm -rf /var/lib/apt/lists/*

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json first
# Doing this before copying the rest of the code leverages Docker layer caching
COPY package*.json ./

# Install the Node.js dependencies
RUN npm install

# Copy the rest of the project files into the container
COPY . .

# Expose port 10000 so the application can be accessed
EXPOSE 10000

# Set the start command to run the application
CMD ["npm", "start"]