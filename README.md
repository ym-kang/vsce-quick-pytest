# Pytest Quick Run

Pytest Quick Run adds `▶ Run ...` and `🐞 Debug ...` CodeLens buttons above pytest functions. They run only that pytest node directly:

```text
python3 -m pytest path/to/test_math.py::test_add
python3 -m pytest path/to/test_math.py::TestMath::test_add
```

It does not call VS Code's test discovery API and does not scan the repository before every run. Pytest still performs its normal collection for the selected file/node, but unrelated test files are not discovered.

`-s` is enabled by default, so `print()` output is shown immediately in the integrated terminal. Debug requires the Microsoft Python and Python Debugger extensions.

## Supported declarations

- Any Python file, regardless of its filename or directory
- Module-level `test_*` functions
- `test_*` methods inside `Test*` classes

## Settings

- `pytestQuickRun.pythonPath`: Python executable. Empty uses the configured Python extension interpreter, then `python3`.
- `pytestQuickRun.pytestArgs`: extra pytest arguments. Defaults to `["-s"]` so `print()` output is not captured.
- `pytestQuickRun.cwd`: pytest working directory. Empty uses the workspace root.

The command palette also provides **Pytest Quick Run: Run Test at Cursor**.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.
