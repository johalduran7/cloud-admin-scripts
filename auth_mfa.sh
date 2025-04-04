#!/bin/bash

#Authenticate to several profiles at the same time by adding the MFA code.

CREDENTIALS_FILE=~/.aws/credentials
CONFIG_FILE=~/.aws/config

echo "Refreshing AWS MFA session tokens..."

# Extract profiles excluding na4_devops
PROFILES=$(grep -oE '\[profile [a-zA-Z0-9_-]+\]' "$CONFIG_FILE" | sed 's/\[profile //;s/\]//' | grep '_devops' | grep -v 'uk1_devops')
#PROFILES=$(grep -oE '\[profile [a-zA-Z0-9_-]+\]' "$CONFIG_FILE" | sed 's/\[profile //;s/\]//' | grep '_devops')
#PROFILES="na3_devops"
for PROFILE in $PROFILES; do
    MFA_SERIAL=$(awk -v profile="[profile $PROFILE]" '$0 == profile {found=1} found && /mfa_serial/ {print $3; exit}' "$CONFIG_FILE")
    ROLE_ARN=$(awk -v profile="[profile $PROFILE]" '$0 == profile {found=1} found && /role_arn/ {print $3; exit}' "$CONFIG_FILE")
    REGION=$(awk -v profile="[profile $PROFILE]" '$0 == profile {found=1} found && /region/ {print $3; exit}' "$CONFIG_FILE")
    
    if [[ -z "$MFA_SERIAL" || -z "$ROLE_ARN" ]]; then
        echo "Skipping $PROFILE (MFA or role ARN missing)"
        continue
    fi

    echo "Enter MFA code for $PROFILE ($MFA_SERIAL):"
    read -s MFA_CODE

    CREDENTIALS=$(aws sts assume-role \
        --role-arn "$ROLE_ARN" \
        --role-session-name "$PROFILE-session" \
        --serial-number "$MFA_SERIAL" \
        --token-code "$MFA_CODE" \
        --duration-seconds 3600 --output json)
    
    if [[ $? -ne 0 ]]; then
        echo "Failed to assume role for $PROFILE"
        continue
    fi
    
    AWS_ACCESS_KEY_ID=$(echo "$CREDENTIALS" | jq -r '.Credentials.AccessKeyId')
    AWS_SECRET_ACCESS_KEY=$(echo "$CREDENTIALS" | jq -r '.Credentials.SecretAccessKey')
    AWS_SESSION_TOKEN=$(echo "$CREDENTIALS" | jq -r '.Credentials.SessionToken')
    
    MFA_PROFILE="${PROFILE}-mfa"
    echo "Updating credentials for $MFA_PROFILE..."
    aws configure set aws_access_key_id "$AWS_ACCESS_KEY_ID" --profile "$MFA_PROFILE"
    aws configure set aws_secret_access_key "$AWS_SECRET_ACCESS_KEY" --profile "$MFA_PROFILE"
    aws configure set aws_session_token "$AWS_SESSION_TOKEN" --profile "$MFA_PROFILE"
    aws configure set region "$REGION" --profile "$MFA_PROFILE"

done

echo "MFA sessions refreshed. Use --profile <profile>-mfa to switch."

