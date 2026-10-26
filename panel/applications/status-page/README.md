# Status Page

A real HTTP application demonstrating the definition-only container provider.
The application serves a title and message from `/data/settings.json`. Its image
contains the HTTP implementation and Docker health check. All panel screens,
configuration validation, lifecycle, logs and stopped-data snapshots are supplied
by shared providers. It has no panel adapter or custom browser assets.

Add the package ID to the application registry, then use the package image tools
to check and build its image. Publication and deployment are separate actions.
See [package authoring](../../../docs/APPLICATION_PACKAGES.md).

The default page is public on its allocated HTTP port. Editing requires the
panel's configuration permission and a stopped process. The image runs as the
unprivileged Node user and reads the public configuration; it performs no data
writes. It supports SIGTERM and supplies `/health` for Docker readiness.
