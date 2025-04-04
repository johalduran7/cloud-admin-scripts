#!/bin/bash

# This script is intended to quickly check the storage of loggroups for a given timeframe

PROFILE="devops"
TIMEZONE="America/New_York"
OUTPUT_FILE="log_sizes.csv"

# Convert 4 AM ET yesterday to UTC timestamp
START_TIME=$(TZ=$TIMEZONE date -v-1d -j -f "%Y-%m-%d %H:%M:%S" "$(date -v-1d +%Y-%m-%d) 04:00:00" "+%s")000
# Convert 3:59 AM ET today to UTC timestamp
END_TIME=$(TZ=$TIMEZONE date -j -f "%Y-%m-%d %H:%M:%S" "$(date +%Y-%m-%d) 03:59:59" "+%s")000

echo "Querying logs from $(date -r ${START_TIME%000} -u) to $(date -r ${END_TIME%000} -u)..."

TOTAL_SIZE=0  # Variable to store total size in GB
LOG_SIZES=()  # Array to store log sizes for sorting

# Create CSV header
echo "LogGroup,Size_GB" > "$OUTPUT_FILE"

# Get log groups that start with "/na6/"
LOG_GROUPS=$(aws logs describe-log-groups --profile $PROFILE --query "logGroups[?starts_with(logGroupName, '/na6/')].logGroupName" --output text)

if [[ -z "$LOG_GROUPS" ]]; then
    echo "No log groups found starting with '/na6/'."
    exit 0
fi

for log_group in $LOG_GROUPS; do
    echo "Processing log group: $log_group"

    query_id=$(aws logs start-query \
        --profile $PROFILE \
        --log-group-name "$log_group" \
        --start-time $START_TIME \
        --end-time $END_TIME \
        --query-string "stats sum(@messageBytes) as sizeBytes by @logGroup" \
        --query "queryId" --output text)

    echo "Query started. ID: $query_id"

    sleep 10  # Allow AWS some time to process

    RAW_RESULT=$(aws logs get-query-results --profile $PROFILE --query-id "$query_id" --output text)

    echo "Raw Query Result for $log_group:"
    echo "$RAW_RESULT"

    # Extract the size in bytes
    SIZE_BYTES=$(echo "$RAW_RESULT" | grep -Eo '[0-9]+\.[0-9]+' | head -1)

    if [[ -n "$SIZE_BYTES" ]]; then
        SIZE_GB=$(echo "$SIZE_BYTES / 1073741824" | bc -l)
        SIZE_GB_FORMATTED=$(printf "%.2f" "$SIZE_GB")
        echo "Log Group: $log_group → Size: ${SIZE_GB_FORMATTED} GB"

        # Store log size in an array for sorting
        LOG_SIZES+=("$SIZE_GB_FORMATTED $log_group")

        # Add entry to CSV
        echo "$log_group,$SIZE_GB_FORMATTED" >> "$OUTPUT_FILE"

        # Update total size
        TOTAL_SIZE=$(echo "$TOTAL_SIZE + $SIZE_GB" | bc)
    else
        echo "Log Group: $log_group → Size: 0 GB"
        LOG_SIZES+=("0.00 $log_group")
        echo "$log_group,0.00" >> "$OUTPUT_FILE"
    fi

    echo "--------------------------------------"
done

# Sort log groups by size (largest to smallest)
echo -e "\nSorted Log Sizes:"
printf "%-40s | %-10s\n" "LogGroup" "Size_GB"
printf -- "------------------------------------------|------------\n"

for entry in $(printf "%s\n" "${LOG_SIZES[@]}" | sort -nr); do
    SIZE=$(echo "$entry" | awk '{print $1}')
    GROUP=$(echo "$entry" | cut -d' ' -f2-)
    printf "%-40s | %-10s\n" "$GROUP" "$SIZE"
done

printf -- "------------------------------------------|------------\n"
printf "%-40s | %-10.2f\n" "TOTAL SIZE" "$TOTAL_SIZE"

echo -e "\nResults saved to: $OUTPUT_FILE"

