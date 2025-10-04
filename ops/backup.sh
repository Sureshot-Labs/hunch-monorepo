#!/bin/bash

# Backup script for Hunch platform
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BACKUP_DIR=${BACKUP_DIR:-"/backups"}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
S3_BUCKET=${BACKUP_S3_BUCKET:-""}
S3_REGION=${BACKUP_S3_REGION:-"us-east-1"}
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="hunch_backup_${TIMESTAMP}"

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
    
    # Check if pg_dump is available
    if ! command -v pg_dump &> /dev/null; then
        log_error "pg_dump is not installed"
        exit 1
    fi
    
    # Check if redis-cli is available
    if ! command -v redis-cli &> /dev/null; then
        log_error "redis-cli is not installed"
        exit 1
    fi
    
    # Check if aws cli is available (for S3 backup)
    if [ -n "$S3_BUCKET" ] && ! command -v aws &> /dev/null; then
        log_error "aws cli is not installed but S3_BUCKET is configured"
        exit 1
    fi
    
    # Create backup directory
    mkdir -p "$BACKUP_DIR"
    
    log_success "Prerequisites check completed"
}

# Backup PostgreSQL database
backup_postgres() {
    log_info "Backing up PostgreSQL database..."
    
    local db_backup_file="$BACKUP_DIR/${BACKUP_NAME}_postgres.sql"
    
    # Get database connection details
    local db_host=${POSTGRES_HOST:-"localhost"}
    local db_port=${POSTGRES_PORT:-"5432"}
    local db_name=${POSTGRES_DB:-"hunch"}
    local db_user=${POSTGRES_USER:-"hunch"}
    
    # Create database backup
    PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
        -h "$db_host" \
        -p "$db_port" \
        -U "$db_user" \
        -d "$db_name" \
        --verbose \
        --no-password \
        --format=plain \
        --file="$db_backup_file"
    
    if [ $? -eq 0 ]; then
        log_success "PostgreSQL backup completed: $db_backup_file"
        
        # Compress backup
        gzip "$db_backup_file"
        log_success "PostgreSQL backup compressed: ${db_backup_file}.gz"
    else
        log_error "PostgreSQL backup failed"
        exit 1
    fi
}

# Backup Redis data
backup_redis() {
    log_info "Backing up Redis data..."
    
    local redis_backup_file="$BACKUP_DIR/${BACKUP_NAME}_redis.rdb"
    
    # Get Redis connection details
    local redis_host=${REDIS_HOST:-"localhost"}
    local redis_port=${REDIS_PORT:-"6379"}
    
    # Create Redis backup
    redis-cli -h "$redis_host" -p "$redis_port" -a "$REDIS_PASSWORD" --rdb "$redis_backup_file"
    
    if [ $? -eq 0 ]; then
        log_success "Redis backup completed: $redis_backup_file"
        
        # Compress backup
        gzip "$redis_backup_file"
        log_success "Redis backup compressed: ${redis_backup_file}.gz"
    else
        log_error "Redis backup failed"
        exit 1
    fi
}

# Backup application data
backup_app_data() {
    log_info "Backing up application data..."
    
    local app_backup_file="$BACKUP_DIR/${BACKUP_NAME}_app_data.tar.gz"
    
    # Create application data backup
    tar -czf "$app_backup_file" \
        --exclude="node_modules" \
        --exclude=".git" \
        --exclude="dist" \
        --exclude="coverage" \
        --exclude="*.log" \
        --exclude="*.tmp" \
        .
    
    if [ $? -eq 0 ]; then
        log_success "Application data backup completed: $app_backup_file"
    else
        log_error "Application data backup failed"
        exit 1
    fi
}

# Backup configuration files
backup_config() {
    log_info "Backing up configuration files..."
    
    local config_backup_file="$BACKUP_DIR/${BACKUP_NAME}_config.tar.gz"
    
    # Create configuration backup
    tar -czf "$config_backup_file" \
        ops/ \
        .env* \
        package.json \
        pnpm-lock.yaml \
        tsconfig.base.json \
        turbo.json
    
    if [ $? -eq 0 ]; then
        log_success "Configuration backup completed: $config_backup_file"
    else
        log_error "Configuration backup failed"
        exit 1
    fi
}

# Upload to S3
upload_to_s3() {
    if [ -z "$S3_BUCKET" ]; then
        log_warning "S3_BUCKET not configured - skipping S3 upload"
        return
    fi
    
    log_info "Uploading backups to S3..."
    
    # Upload all backup files
    for file in "$BACKUP_DIR"/${BACKUP_NAME}_*; do
        if [ -f "$file" ]; then
            local s3_key="backups/$(basename "$file")"
            
            aws s3 cp "$file" "s3://$S3_BUCKET/$s3_key" \
                --region "$S3_REGION" \
                --storage-class STANDARD_IA
            
            if [ $? -eq 0 ]; then
                log_success "Uploaded to S3: $s3_key"
            else
                log_error "Failed to upload to S3: $s3_key"
                exit 1
            fi
        fi
    done
    
    log_success "S3 upload completed"
}

# Cleanup old backups
cleanup_old_backups() {
    log_info "Cleaning up old backups..."
    
    # Clean up local backups
    find "$BACKUP_DIR" -name "hunch_backup_*" -type f -mtime +$RETENTION_DAYS -delete
    
    # Clean up S3 backups
    if [ -n "$S3_BUCKET" ]; then
        aws s3 ls "s3://$S3_BUCKET/backups/" --region "$S3_REGION" | \
        awk '{print $4}' | \
        grep "hunch_backup_" | \
        while read -r file; do
            local file_date=$(echo "$file" | grep -o '[0-9]\{8\}_[0-9]\{6\}')
            local file_timestamp=$(date -d "${file_date:0:8} ${file_date:9:2}:${file_date:11:2}:${file_date:13:2}" +%s)
            local current_timestamp=$(date +%s)
            local age_days=$(( (current_timestamp - file_timestamp) / 86400 ))
            
            if [ $age_days -gt $RETENTION_DAYS ]; then
                aws s3 rm "s3://$S3_BUCKET/backups/$file" --region "$S3_REGION"
                log_info "Deleted old S3 backup: $file"
            fi
        done
    fi
    
    log_success "Cleanup completed"
}

# Create backup manifest
create_manifest() {
    log_info "Creating backup manifest..."
    
    local manifest_file="$BACKUP_DIR/${BACKUP_NAME}_manifest.json"
    
    cat > "$manifest_file" << EOF
{
  "backup_name": "$BACKUP_NAME",
  "timestamp": "$TIMESTAMP",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "backup_files": [
EOF

    # Add backup files to manifest
    local first=true
    for file in "$BACKUP_DIR"/${BACKUP_NAME}_*; do
        if [ -f "$file" ]; then
            if [ "$first" = true ]; then
                first=false
            else
                echo "," >> "$manifest_file"
            fi
            
            local file_size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
            local file_checksum=$(md5sum "$file" | cut -d' ' -f1)
            
            cat >> "$manifest_file" << EOF
    {
      "filename": "$(basename "$file")",
      "size": $file_size,
      "checksum": "$file_checksum"
    }
EOF
        fi
    done
    
    cat >> "$manifest_file" << EOF
  ],
  "environment": {
    "postgres_host": "${POSTGRES_HOST:-localhost}",
    "postgres_port": "${POSTGRES_PORT:-5432}",
    "postgres_db": "${POSTGRES_DB:-hunch}",
    "redis_host": "${REDIS_HOST:-localhost}",
    "redis_port": "${REDIS_PORT:-6379}",
    "backup_retention_days": $RETENTION_DAYS
  }
}
EOF

    log_success "Backup manifest created: $manifest_file"
}

# Restore function
restore_backup() {
    local backup_name=$1
    
    if [ -z "$backup_name" ]; then
        log_error "Backup name is required for restore"
        exit 1
    fi
    
    log_info "Restoring backup: $backup_name"
    
    # Find backup files
    local postgres_backup=$(find "$BACKUP_DIR" -name "${backup_name}_postgres.sql.gz" | head -1)
    local redis_backup=$(find "$BACKUP_DIR" -name "${backup_name}_redis.rdb.gz" | head -1)
    local app_backup=$(find "$BACKUP_DIR" -name "${backup_name}_app_data.tar.gz" | head -1)
    local config_backup=$(find "$BACKUP_DIR" -name "${backup_name}_config.tar.gz" | head -1)
    
    # Restore PostgreSQL
    if [ -n "$postgres_backup" ]; then
        log_info "Restoring PostgreSQL database..."
        gunzip -c "$postgres_backup" | PGPASSWORD="$POSTGRES_PASSWORD" psql \
            -h "${POSTGRES_HOST:-localhost}" \
            -p "${POSTGRES_PORT:-5432}" \
            -U "${POSTGRES_USER:-hunch}" \
            -d "${POSTGRES_DB:-hunch}"
        log_success "PostgreSQL restore completed"
    fi
    
    # Restore Redis
    if [ -n "$redis_backup" ]; then
        log_info "Restoring Redis data..."
        gunzip -c "$redis_backup" > /tmp/restore.rdb
        redis-cli -h "${REDIS_HOST:-localhost}" -p "${REDIS_PORT:-6379}" -a "$REDIS_PASSWORD" --rdb /tmp/restore.rdb
        rm /tmp/restore.rdb
        log_success "Redis restore completed"
    fi
    
    # Restore application data
    if [ -n "$app_backup" ]; then
        log_info "Restoring application data..."
        tar -xzf "$app_backup"
        log_success "Application data restore completed"
    fi
    
    # Restore configuration
    if [ -n "$config_backup" ]; then
        log_info "Restoring configuration..."
        tar -xzf "$config_backup"
        log_success "Configuration restore completed"
    fi
    
    log_success "Backup restore completed"
}

# List available backups
list_backups() {
    log_info "Available backups:"
    
    # List local backups
    echo "Local backups:"
    ls -la "$BACKUP_DIR"/hunch_backup_* 2>/dev/null || echo "No local backups found"
    
    # List S3 backups
    if [ -n "$S3_BUCKET" ]; then
        echo "S3 backups:"
        aws s3 ls "s3://$S3_BUCKET/backups/" --region "$S3_REGION" | grep "hunch_backup_" || echo "No S3 backups found"
    fi
}

# Main function
main() {
    local action=${1:-"backup"}
    
    case $action in
        "backup")
            log_info "Starting backup process..."
            check_prerequisites
            backup_postgres
            backup_redis
            backup_app_data
            backup_config
            create_manifest
            upload_to_s3
            cleanup_old_backups
            log_success "Backup process completed successfully!"
            ;;
        "restore")
            local backup_name=$2
            log_info "Starting restore process..."
            check_prerequisites
            restore_backup "$backup_name"
            log_success "Restore process completed successfully!"
            ;;
        "list")
            list_backups
            ;;
        *)
            echo "Usage: $0 {backup|restore|list} [backup_name]"
            echo "  backup  - Create a new backup"
            echo "  restore - Restore from a backup (requires backup_name)"
            echo "  list    - List available backups"
            exit 1
            ;;
    esac
}

# Run main function
main "$@"
