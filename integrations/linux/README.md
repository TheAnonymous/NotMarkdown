# Linux integration scaffold

A release package should:

1. install `../mime/shared-mime-info.xml` through the distribution's normal
   shared-mime-info mechanism;
2. substitute an absolute, safely quoted executable into
   `notmarkdown-studio.desktop.in`;
3. install the resulting desktop entry and icon in the package-owned prefix;
4. update MIME and desktop databases only through package-manager hooks;
5. register a sandboxed thumbnailer only after the read-only renderer has a
   stable, resource-limited command surface.

The source template deliberately contains no hard-coded installation path.
It is ready for local packaging tests but is not installed merely by being
present in the repository. Distribution packages remain responsible for
choosing the executable path, icon sizes, package prefix, and lifecycle hooks.
