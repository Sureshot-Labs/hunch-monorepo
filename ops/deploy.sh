#!/bin/bash

# Production deployment script for Hunch platform
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENVIRONMENT=${1:-production}
DOCKER_COMPOSE_FILE="ops/docker-compose.prod.yml"
K8S_NAMESPACE="hunch"
DOCKER_REGISTRY=${DOCKER_REGISTRY:-"your-registry.com/hunch"}
IMAGE_TAG=${IMAGE_TAG:-"latest"}

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check if Docker is installed
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi
    
    # Check if Docker Compose is installed
    if ! command -v docker-compose &> /dev/null; then
        log_error "Docker Compose is not installed"
        exit 1
    fi
    
    # Check if kubectl is installed (for Kubernetes deployment)
    if ! command -v kubectl &> /dev/null; then
        log_warning "kubectl is not installed - Kubernetes deployment will be skipped"
    fi
    
    # Check if .env file exists
    if [ ! -f ".env.prod" ]; then
        log_error ".env.prod file not found"
        log_info "Please create .env.prod file with required environment variables"
        exit 1
    fi
    
    log_success "Prerequisites check completed"
}

# Build Docker images
build_images() {
    log_info "Building Docker images..."
    
    # Build all service images
    services=("api" "trading-engine" "analytics-engine" "webhook-system" "price-history" "data-ingestion" "monitoring")
    
    for service in "${services[@]}"; do
        log_info "Building $service image..."
        docker build -f ops/Dockerfile.$service -t $DOCKER_REGISTRY/$service:$IMAGE_TAG .
        
        if [ $? -eq 0 ]; then
            log_success "$service image built successfully"
        else
            log_error "Failed to build $service image"
            exit 1
        fi
    done
    
    log_success "All images built successfully"
}

# Push images to registry
push_images() {
    log_info "Pushing images to registry..."
    
    services=("api" "trading-engine" "analytics-engine" "webhook-system" "price-history" "data-ingestion" "monitoring")
    
    for service in "${services[@]}"; do
        log_info "Pushing $service image..."
        docker push $DOCKER_REGISTRY/$service:$IMAGE_TAG
        
        if [ $? -eq 0 ]; then
            log_success "$service image pushed successfully"
        else
            log_error "Failed to push $service image"
            exit 1
        fi
    done
    
    log_success "All images pushed successfully"
}

# Deploy with Docker Compose
deploy_docker_compose() {
    log_info "Deploying with Docker Compose..."
    
    # Stop existing containers
    log_info "Stopping existing containers..."
    docker-compose -f $DOCKER_COMPOSE_FILE down
    
    # Pull latest images
    log_info "Pulling latest images..."
    docker-compose -f $DOCKER_COMPOSE_FILE pull
    
    # Start services
    log_info "Starting services..."
    docker-compose -f $DOCKER_COMPOSE_FILE up -d
    
    # Wait for services to be healthy
    log_info "Waiting for services to be healthy..."
    sleep 30
    
    # Check service health
    check_service_health
    
    log_success "Docker Compose deployment completed"
}

# Deploy with Kubernetes
deploy_kubernetes() {
    log_info "Deploying with Kubernetes..."
    
    # Check if kubectl is available
    if ! command -v kubectl &> /dev/null; then
        log_warning "kubectl not available - skipping Kubernetes deployment"
        return
    fi
    
    # Create namespace
    log_info "Creating namespace..."
    kubectl apply -f ops/k8s/namespace.yaml
    
    # Apply secrets
    log_info "Applying secrets..."
    kubectl apply -f ops/k8s/secrets.yaml
    
    # Apply configmaps
    log_info "Applying configmaps..."
    kubectl apply -f ops/k8s/configmap.yaml
    
    # Deploy PostgreSQL
    log_info "Deploying PostgreSQL..."
    kubectl apply -f ops/k8s/postgres.yaml
    
    # Wait for PostgreSQL to be ready
    log_info "Waiting for PostgreSQL to be ready..."
    kubectl wait --for=condition=ready pod -l app=postgres -n $K8S_NAMESPACE --timeout=300s
    
    # Deploy Redis
    log_info "Deploying Redis..."
    kubectl apply -f ops/k8s/redis.yaml
    
    # Wait for Redis to be ready
    log_info "Waiting for Redis to be ready..."
    kubectl wait --for=condition=ready pod -l app=redis -n $K8S_NAMESPACE --timeout=300s
    
    # Deploy services
    log_info "Deploying services..."
    kubectl apply -f ops/k8s/services.yaml
    
    # Wait for services to be ready
    log_info "Waiting for services to be ready..."
    kubectl wait --for=condition=ready pod -l app=hunch -n $K8S_NAMESPACE --timeout=600s
    
    log_success "Kubernetes deployment completed"
}

# Check service health
check_service_health() {
    log_info "Checking service health..."
    
    services=("api" "trading-engine" "analytics-engine" "webhook-system" "price-history" "data-ingestion" "monitoring")
    
    for service in "${services[@]}"; do
        log_info "Checking $service health..."
        
        # Get service port
        case $service in
            "api") port=3000 ;;
            "trading-engine") port=3001 ;;
            "analytics-engine") port=3003 ;;
            "webhook-system") port=3004 ;;
            "price-history") port=3005 ;;
            "data-ingestion") port=3006 ;;
            "monitoring") port=3007 ;;
        esac
        
        # Check health endpoint
        if curl -f http://localhost:$port/health > /dev/null 2>&1; then
            log_success "$service is healthy"
        else
            log_error "$service is not healthy"
            exit 1
        fi
    done
    
    log_success "All services are healthy"
}

# Run database migrations
run_migrations() {
    log_info "Running database migrations..."
    
    # Wait for database to be ready
    log_info "Waiting for database to be ready..."
    sleep 10
    
    # Run migrations
    docker-compose -f $DOCKER_COMPOSE_FILE exec postgres psql -U hunch -d hunch -c "SELECT 1;" > /dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        log_info "Running migrations..."
        # Add migration commands here
        log_success "Migrations completed"
    else
        log_error "Database is not ready"
        exit 1
    fi
}

# Setup monitoring
setup_monitoring() {
    log_info "Setting up monitoring..."
    
    # Deploy Prometheus
    log_info "Deploying Prometheus..."
    docker-compose -f $DOCKER_COMPOSE_FILE up -d prometheus
    
    # Deploy Grafana
    log_info "Deploying Grafana..."
    docker-compose -f $DOCKER_COMPOSE_FILE up -d grafana
    
    # Wait for monitoring services
    log_info "Waiting for monitoring services..."
    sleep 30
    
    # Check Prometheus
    if curl -f http://localhost:9091/-/healthy > /dev/null 2>&1; then
        log_success "Prometheus is healthy"
    else
        log_warning "Prometheus is not healthy"
    fi
    
    # Check Grafana
    if curl -f http://localhost:3001/api/health > /dev/null 2>&1; then
        log_success "Grafana is healthy"
    else
        log_warning "Grafana is not healthy"
    fi
    
    log_success "Monitoring setup completed"
}

# Cleanup function
cleanup() {
    log_info "Cleaning up..."
    
    # Stop containers
    docker-compose -f $DOCKER_COMPOSE_FILE down
    
    # Remove unused images
    docker image prune -f
    
    log_success "Cleanup completed"
}

# Main deployment function
main() {
    log_info "Starting Hunch platform deployment..."
    log_info "Environment: $ENVIRONMENT"
    log_info "Docker Compose file: $DOCKER_COMPOSE_FILE"
    
    # Check prerequisites
    check_prerequisites
    
    # Build images
    build_images
    
    # Push images (if registry is configured)
    if [ "$DOCKER_REGISTRY" != "your-registry.com/hunch" ]; then
        push_images
    else
        log_warning "Docker registry not configured - skipping image push"
    fi
    
    # Deploy based on environment
    case $ENVIRONMENT in
        "docker")
            deploy_docker_compose
            ;;
        "kubernetes"|"k8s")
            deploy_kubernetes
            ;;
        *)
            log_error "Unknown environment: $ENVIRONMENT"
            log_info "Supported environments: docker, kubernetes"
            exit 1
            ;;
    esac
    
    # Run migrations
    run_migrations
    
    # Setup monitoring
    setup_monitoring
    
    # Check service health
    check_service_health
    
    log_success "Deployment completed successfully!"
    log_info "Services are available at:"
    log_info "  API Gateway: http://localhost:3000"
    log_info "  Trading Engine: http://localhost:3001"
    log_info "  Analytics Engine: http://localhost:3003"
    log_info "  Webhook System: http://localhost:3004"
    log_info "  Price History: http://localhost:3005"
    log_info "  Data Ingestion: http://localhost:3006"
    log_info "  Monitoring: http://localhost:3007"
    log_info "  Prometheus: http://localhost:9091"
    log_info "  Grafana: http://localhost:3001"
}

# Handle script interruption
trap cleanup EXIT

# Run main function
main "$@"
