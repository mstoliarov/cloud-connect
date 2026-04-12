# cloud-connect — smart proxy for Claude CLI
# https://github.com/mstoliarov/cloud-connect

function claude-claude {
    $env:_CLAUDE_SETTINGS = "$env:USERPROFILE\.claude\settings-claude.json"
    & claude @args
    Remove-Item Env:_CLAUDE_SETTINGS -ErrorAction SilentlyContinue
}

function claude-ollama {
    $env:_CLAUDE_SETTINGS = "$env:USERPROFILE\.claude\settings-ollama.json"
    & claude @args
    Remove-Item Env:_CLAUDE_SETTINGS -ErrorAction SilentlyContinue
}
