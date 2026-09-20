# Pytest Quick Run

Pytest Quick Run adds `▶ Run ...` and `🐞 Debug ...` CodeLens buttons above pytest functions. They run only that pytest node directly:

```text
python3 -m pytest path/to/test_math.py::test_add
python3 -m pytest path/to/test_math.py::TestMath::test_add
```

It does not call VS Code's test discovery API and does not scan the repository before every run. Pytest still performs its normal collection for the selected file/node, but unrelated test files are not discovered.

`-s` is enabled by default, so `print()` output is shown immediately in the integrated terminal. Debug requires the Microsoft Python and Python Debugger extensions.

When you click `Run` or `Debug`, a centered configuration panel opens in the editor before execution:

1. Additional pytest arguments, such as `-s --maxfail=1 --tb=short`
2. Environment variables in `KEY=VALUE; KEY2=VALUE2` format

The settings below provide the default values shown in those dialogs. You can change them for a single run without editing `settings.json`.

After a run, the entered values are saved as the most recent configuration for the current workspace and restored the next time a test is launched.

## Supported declarations

- Any Python file, regardless of its filename or directory
- Module-level `test_*` functions
- `test_*` methods inside `Test*` classes

## Settings

- `pytestQuickRun.pythonPath`: Python executable. Empty uses the configured Python extension interpreter, then `python3`.
- `pytestQuickRun.pytestArgs`: additional pytest arguments. Defaults to `["-s"]` so `print()` output is not captured. For example, `["-x", "--tb=short"]`.
- `pytestQuickRun.environmentVariables`: environment variables passed to both run and debug, for example `{ "APP_ENV": "test", "DJANGO_SETTINGS_MODULE": "config.settings" }`.
- `pytestQuickRun.cwd`: pytest working directory. Empty uses the workspace root.

The command palette also provides **Pytest Quick Run: Run Test at Cursor**.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.
