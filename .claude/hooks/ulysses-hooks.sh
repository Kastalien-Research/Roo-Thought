#!/bin/bash
# Ulysses Protocol Hard Gates
# These hooks enforce ground-truth verification at checkpoints

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
HOOK_LOG="${REPO_ROOT}/.claude/hook-execution.log"

log() {
    echo "[$(date -Iseconds)] $1" >> "$HOOK_LOG"
    echo "$1"
}

# =============================================================================
# HOOK 1: Pre-Edit Gate - Runs BEFORE any file edit
# Checks if we're about to import from a package that isn't installed
# =============================================================================
pre_edit_import_check() {
    local file="$1"
    local new_content="$2"

    log "PRE-EDIT: Checking imports in $file"

    # Extract import statements from the new content
    local imports=$(echo "$new_content" | grep -E "^import.*from ['\"]" | sed -E "s/.*from ['\"]([^'\"]+)['\"].*/\1/" | grep -v "^\." | grep -v "^@roo-code")

    if [ -z "$imports" ]; then
        log "PRE-EDIT: No external imports found"
        return 0
    fi

    # Find the nearest package.json
    local pkg_dir=$(dirname "$file")
    while [ "$pkg_dir" != "/" ] && [ ! -f "$pkg_dir/package.json" ]; do
        pkg_dir=$(dirname "$pkg_dir")
    done

    if [ ! -f "$pkg_dir/package.json" ]; then
        log "PRE-EDIT: WARNING - No package.json found"
        return 0
    fi

    local pkg_json="$pkg_dir/package.json"
    log "PRE-EDIT: Checking against $pkg_json"

    # Check each import
    for imp in $imports; do
        # Get the package name (first part before /)
        local pkg_name=$(echo "$imp" | cut -d'/' -f1)

        # Skip node built-ins
        if [[ "$pkg_name" =~ ^(fs|path|os|util|crypto|http|https|stream|buffer|events|child_process|net|url)$ ]]; then
            continue
        fi

        # Check if package exists in dependencies or devDependencies
        if ! grep -q "\"$pkg_name\"" "$pkg_json"; then
            log "PRE-EDIT: BLOCKED - Package '$pkg_name' not in $pkg_json"
            echo "ERROR: Attempting to import from '$pkg_name' which is not installed"
            echo "Run: pnpm add $pkg_name"
            return 1
        fi
    done

    log "PRE-EDIT: All imports verified"
    return 0
}

# =============================================================================
# HOOK 2: Post-Checkpoint Gate - Runs AFTER each Ulysses checkpoint
# Verifies the checkpoint with actual compilation
# =============================================================================
post_checkpoint_verify() {
    local checkpoint_id="$1"
    local workspace="${2:-$REPO_ROOT}"

    log "CHECKPOINT $checkpoint_id: Running verification"

    # Step 1: Install dependencies (in case new ones were added)
    log "CHECKPOINT $checkpoint_id: Installing dependencies..."
    if ! (cd "$workspace" && pnpm install --frozen-lockfile 2>&1); then
        # If frozen lockfile fails, try regular install
        if ! (cd "$workspace" && pnpm install 2>&1); then
            log "CHECKPOINT $checkpoint_id: FAILED - pnpm install failed"
            return 1
        fi
    fi

    # Step 2: Type check
    log "CHECKPOINT $checkpoint_id: Running type check..."
    local tsc_output
    if ! tsc_output=$(cd "$workspace" && pnpm exec tsc --noEmit 2>&1); then
        log "CHECKPOINT $checkpoint_id: FAILED - Type check failed"
        echo "$tsc_output"
        return 1
    fi

    log "CHECKPOINT $checkpoint_id: PASSED"
    return 0
}

# =============================================================================
# HOOK 3: New Dependency Gate - Runs when package.json is modified
# Ensures new dependencies are real and types resolve
# =============================================================================
new_dependency_verify() {
    local pkg_json="$1"
    local workspace=$(dirname "$pkg_json")

    log "DEPENDENCY: Verifying new dependencies in $pkg_json"

    # Get list of dependencies
    local deps=$(cat "$pkg_json" | grep -A 1000 '"dependencies"' | grep -B 1000 '}' | head -n -1 | grep '"' | cut -d'"' -f2)
    local dev_deps=$(cat "$pkg_json" | grep -A 1000 '"devDependencies"' | grep -B 1000 '}' | head -n -1 | grep '"' | cut -d'"' -f2)

    # Install
    log "DEPENDENCY: Installing..."
    if ! (cd "$workspace" && pnpm install 2>&1); then
        log "DEPENDENCY: FAILED - Install failed"
        return 1
    fi

    # Type check to verify types resolve
    log "DEPENDENCY: Verifying types resolve..."
    if ! (cd "$workspace" && pnpm exec tsc --noEmit 2>&1); then
        log "DEPENDENCY: FAILED - Types don't resolve after install"
        return 1
    fi

    log "DEPENDENCY: PASSED"
    return 0
}

# =============================================================================
# HOOK 4: Mock Detector - Warns when tests mock external modules
# =============================================================================
mock_detector() {
    local test_file="$1"

    log "MOCK-CHECK: Scanning $test_file"

    # Look for vi.mock or jest.mock of external packages
    local external_mocks=$(grep -E "(vi|jest)\.mock\(['\"]" "$test_file" | grep -v "\./" | grep -v "@roo-code" || true)

    if [ -n "$external_mocks" ]; then
        log "MOCK-CHECK: WARNING - External module mocks detected"
        echo "WARNING: Test file mocks external modules:"
        echo "$external_mocks"
        echo ""
        echo "Verify that the real module is installed and types resolve:"

        # Extract package names
        echo "$external_mocks" | sed -E "s/.*mock\(['\"]([^'\"]+)['\"].*/\1/" | while read pkg; do
            local pkg_name=$(echo "$pkg" | cut -d'/' -f1)
            echo "  - $pkg_name: run 'pnpm add $pkg_name && pnpm exec tsc --noEmit'"
        done

        # This is a warning, not a block - but it gets logged
        log "MOCK-CHECK: Mocks logged for review"
    fi

    return 0
}

# =============================================================================
# HOOK 5: Ulysses Checkpoint Wrapper
# Call this at each checkpoint transition
# =============================================================================
ulysses_checkpoint() {
    local checkpoint_id="$1"
    local description="$2"

    echo "========================================"
    echo "ULYSSES CHECKPOINT $checkpoint_id"
    echo "$description"
    echo "========================================"

    log "ULYSSES: Checkpoint $checkpoint_id - $description"

    # Run the hard verification
    if ! post_checkpoint_verify "$checkpoint_id"; then
        echo ""
        echo "CHECKPOINT $checkpoint_id FAILED VERIFICATION"
        echo "Cannot proceed until this is fixed."
        echo ""
        log "ULYSSES: Checkpoint $checkpoint_id BLOCKED"
        return 1
    fi

    echo ""
    echo "CHECKPOINT $checkpoint_id VERIFIED"
    echo ""
    log "ULYSSES: Checkpoint $checkpoint_id PASSED"

    # Record checkpoint in state file
    local state_file="${REPO_ROOT}/.claude/ulysses-state.json"
    if [ -f "$state_file" ]; then
        # Update checkpoint in state file (simplified - real impl would use jq)
        log "ULYSSES: State updated"
    fi

    return 0
}

# =============================================================================
# MAIN: Dispatch based on hook type
# =============================================================================
case "${1:-help}" in
    pre-edit)
        pre_edit_import_check "$2" "$3"
        ;;
    checkpoint)
        ulysses_checkpoint "$2" "${3:-Checkpoint verification}"
        ;;
    dependency)
        new_dependency_verify "$2"
        ;;
    mock-check)
        mock_detector "$2"
        ;;
    verify)
        post_checkpoint_verify "manual" "${2:-$REPO_ROOT}"
        ;;
    *)
        echo "Ulysses Protocol Hooks"
        echo ""
        echo "Usage:"
        echo "  $0 pre-edit <file> <new-content>  - Check imports before edit"
        echo "  $0 checkpoint <id> [description]  - Verify checkpoint"
        echo "  $0 dependency <package.json>      - Verify new dependencies"
        echo "  $0 mock-check <test-file>         - Detect external mocks"
        echo "  $0 verify [workspace]             - Run full verification"
        ;;
esac
