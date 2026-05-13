# RunRec

Internal tools for RunRec. Hosted on GitHub Pages.

Live: https://saldader.github.io/dashboards/

## Structure

```
dashboards/
├── index.html              ← landing page (lists all dashboards)
└── runrec-sales/
    └── index.html          ← RunRec sales playbook (birthday + membership)
```

## Adding a new dashboard

1. Create a folder: `mkdir new-dashboard-name`
2. Drop an `index.html` inside
3. Add a card to the root `index.html` linking to it
4. Push to `main` — auto-deploys to `saldader.github.io/dashboards/new-dashboard-name/`

## Source data

RunRec sales dashboard is built from real Quo (formerly OpenPhone) call transcripts. Re-pull anytime:

```bash
python3 ~/.aos/work/runrec/quo_pull.py
```
