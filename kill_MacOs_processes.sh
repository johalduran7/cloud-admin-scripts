#!/bin/bash
# Kill processes of MacOs when unlocking the laptop

# sudo crontab -e
#* * * * * bash -l /Users/johnduran/scripts/kill_MacOs_processes.sh 2>&1

# detects if I unlocked the session within the previous minute
output=$(log show --last 1m | grep 'activateForUserName: johnduran sessionUnlocked');

if [ -n "$output" ] ; then 
    pgrep -f -i sleep | sudo xargs kill -9 #kills some loops remaining in the background about this very script
    while true; do pgrep -f -i mds ir_agent installd intune UpdateBrainService | sudo xargs kill -9; sleep 3; done
fi
