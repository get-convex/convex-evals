import re
import os


def sanitize_output(text: str) -> str:
    try:
        # Remove ANSI CSI, OSC (BEL/ST terminated), hyperlinks, and 7-bit C1 escapes
        patterns = [
            r"\x1B\[[0-?]*[ -/]*[@-~]",   # CSI sequences
            r"\x1B\][^\x07]*\x07",       # OSC sequences terminated by BEL
            r"\x1B\]8;;.*?\x1B\\",      # OSC 8 hyperlinks (ST-terminated)
            r"\x1B[@-Z\\-_]",            # 7-bit C1 escapes
        ]
        out = text
        for p in patterns:
            out = re.sub(p, "", out)
        return out
    except Exception:
        return text


def append_log(log_path: str, text: str) -> None:
    try:
        with open(log_path, "a", encoding="utf-8") as f:
            sanitized = sanitize_output(text)
            f.write(sanitized)
            if not sanitized.endswith("\n"):
                f.write("\n")
    except Exception:
        # Best-effort logging; ignore failures
        pass


def append_log_block(log_path: str, prefix: str, content: str) -> None:
    if content is None:
        return
    sanitized = sanitize_output(content)
    for line in sanitized.splitlines():
        append_log(log_path, f"[{prefix}] {line}")


def log_cmd_results(log_path: str, results, prefix: str, *, cmd_prefix: str = "") -> None:
    """Write a standardized [cmd] line and prefixed output for a list of (cmd, stdout)."""
    if not results:
        return
    for cmd, stdout in results:
        try:
            cmd_str = " ".join(cmd)
        except Exception:
            cmd_str = str(cmd)
        if cmd_prefix:
            append_log(log_path, f"[cmd] {cmd_prefix}{cmd_str}")
        else:
            append_log(log_path, f"[cmd] {cmd_str}")
        append_log_block(log_path, prefix, stdout)


def log_info(message: str) -> None:
    verbose = os.getenv("VERBOSE_INFO_LOGS", "").lower() in {"1", "true", "yes"}
    if not verbose:
        return
    print(message, flush=True)


def run_command_step(log_path: str, handler, prefix: str, error_label: str, *, cmd_prefix: str = "") -> bool:
    """Execute a handler that returns (cmd, stdout) pairs; log results or error.

    - handler: callable with no args that returns list[tuple[list[str] | str, str]]
    - prefix: label for stdout lines in append_log_block
    - error_label: label used when recording an error
    - cmd_prefix: optional prefix for the recorded command line
    Returns True on success, False on exception.
    """
    try:
        results = handler()
        log_cmd_results(log_path, results, prefix, cmd_prefix=cmd_prefix)
        return True
    except Exception as e:
        append_log(log_path, f"[error] {error_label}: {e}")
        return False


