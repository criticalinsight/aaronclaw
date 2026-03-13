-- AaronClaw Docs Factory Trigger & Monitor
-- 🧙🏾‍♂️: Rich Hickey would automate the tedious.

set authToken to ""
set handId to "docs-factory"
set baseUrl to "https://aaronclaw.workers.dev" -- Production URL

display dialog "Enter AaronClaw APP_AUTH_TOKEN:" default answer "" with hidden answer
set authToken to text returned of result

if authToken is "" then
    display alert "Auth token is required."
    return
end if

display notification "Triggering Docs Factory build..." with title "AaronClaw"

-- 1. Trigger the Run
set triggerCmd to "curl -X POST " & quoted form of (baseUrl & "/api/hands/" & handId & "/run") & " -H " & quoted form of ("Authorization: Bearer " & authToken) & " -s"
set triggerResponse to do shell script triggerCmd

if triggerResponse contains "error" then
    display alert "Failed to trigger build: " & triggerResponse
    return
end if

display notification "Build triggered. Monitoring progress..." with title "AaronClaw"

-- 2. Monitor Poll Loop
set isComplete to false
repeat until isComplete
    delay 5 -- Wait 5 seconds between polls
    
    set statusCmd to "curl " & quoted form of (baseUrl & "/api/hands/" & handId) & " -H " & quoted form of ("Authorization: Bearer " & authToken) & " -s"
    set statusResponse to do shell script statusCmd
    
    -- Parse summary status from JSON (primitive parsing for AppleScript)
    if statusResponse contains "\"status\": \"active\"" then
        -- Check if latest run is complete
        -- We look for the "latestRun" object and its "status"
        if statusResponse contains "latestRun" then
            if statusResponse contains "\"status\": \"succeeded\"" then
                set isComplete to true
                display notification "Docs Factory build SUCCEEDED!" with title "AaronClaw"
                display dialog "Documentation build and deployment completed successfully." buttons {"OK"} default button "OK"
            else if statusResponse contains "\"status\": \"failed\"" then
                set isComplete to true
                display alert "Docs Factory build FAILED. Check logs in AaronClaw dashboard."
            end if
        end if
    else
        display alert "Hand is not active. Please activate docs-factory first."
        return
    end if
end repeat
