"""Offline release preparation. This package does not ship production Brain content."""

from knowledge.release.manifest import manifest_from_document
from knowledge.release.publish import publish_candidate

__all__ = ["manifest_from_document", "publish_candidate"]
