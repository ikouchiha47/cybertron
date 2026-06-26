#!/usr/bin/env python3
"""Memory CLI wrapper - installed as 'memory' command."""
import sys
from pathlib import Path

# Add skills directory to path
sys.path.insert(0, str(Path.home() / ".claude" / "skills" / "memory"))
sys.path.insert(0, str(Path.home() / "dev" / "ideas" / "huh" / "memory" / "lib"))

from cli import main

if __name__ == "__main__":
    main()
