# Guided tour copy

Each guided tour has one authored Markdown file in this directory. Edit that file to change
the tour name, a stage title, or a stage description:

- `see-work.md`
- `library.md`
- `setup.md`

The H1 is the tour name. Each H2 is a stage title, and the prose below it is that stage's
description. The `stage` comment under an H2 is a stable code identifier; do not change or
remove it when editing copy. A final list in this form becomes the stage's term and definition
list:

```md
- **Label:** Description
```

After editing, run `npm run tours` and commit the regenerated module. The generated TypeScript
file is build output and must not be edited by hand.
