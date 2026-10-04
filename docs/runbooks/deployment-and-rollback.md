# Deployment and rollback

`infra/k8s/base` is a packaging skeleton. Render it with `kubectl kustomize infra/k8s/base`. Do not apply it from this task. Images are tagged `unqualified` until a profile repeats the gates it changes.

Rollback keeps existing conversation pins and native files. A changed transport digest, storage profile, or workload invalidates reuse of an older capacity measurement. Package validation is not deployment.
