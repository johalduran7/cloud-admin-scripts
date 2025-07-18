#!/bin/bash
# Kill processes of MacOs when unlocking the laptop

# sudo crontab -e
#* * * * * bash -l /Users/johnduran/scripts/kill_MacOs_processes.sh 2>&1

# detects if I unlocked the session within the previous minute
output=$(log show --last 1m | grep 'activateForUserName: johnduran sessionUnlocked');

if [ -n "$output" ] ; then 
    echo "Login: YES -> " $output;
    pgrep -f -i sleep kill_MacOs_processes | sudo xargs kill -9 #kills some loops remaining in the background about this very script
    while true; do pgrep -f -i mds ir_agent installd intune UpdateBrainService amagent| sudo xargs kill -9; scutil --nc stop "VPN" ;sleep 3; done
else
    echo "Login: NO" ;
fi

# check the status of the vpn:
scutil --nc status "VPN Connection"  2>&1

# list the vpns (the name of the VPN of forticlient changes every now and then):
networksetup -listallnetworkservices  2>&1
