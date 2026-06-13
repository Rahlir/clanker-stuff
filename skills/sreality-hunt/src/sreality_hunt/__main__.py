"""CLI dispatcher.

Routes argparse subcommands to the `run_*` functions in the business-logic
modules. The CLI itself is thin: it parses args, opens shared resources
(DB connection, SrealityClient, ComparablePricingProvider, fewshot
examples), invokes the right runner, prints markdown to stdout, and maps
known exceptions to clean stderr messages with distinct exit codes.

Subcommand surface:

  search   list | new <name> | show <name> | edit <name>
  digest   <search> [--limit N]
  evaluate <listing-id> [--search NAME] [--from-snapshot]
  fetch    <listing-id> [--from-snapshot]
  mark     <listing-id> <reaction> [--note TEXT] [--search NAME]
  history  [--search NAME] [--reaction TYPE] [--limit N]
  distill  <search> [--apply FILE | --apply -]
  compare  <listing-id> <listing-id> ... [--search NAME] [--from-snapshot]
  open     <listing-id>
  db       init

Global flags:
  -v / --verbose   bump log level (-v INFO, -vv DEBUG; default WARNING)

Output discipline: markdown to stdout, everything else (logs, errors,
progress, confirmations) to stderr. So you can pipe `digest`/`evaluate`
output into a file without losing diagnostic information.
"""

import argparse
import json
import logging
import os
import subprocess
import sys
import webbrowser
from contextlib import closing
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from . import db, models
from .api import ListingNotFound, SrealityClient, SrealityError
from .digest import run_digest
from .evaluate import SnapshotMissing, fetch_and_persist_detail, run_evaluate
from .facts import extract_facts
from .learning import build_fewshot_examples, run_distill, run_history, run_mark
from .models import ListingDetail, SavedSearch
from .pricing import ComparablePricingProvider
from .render import (
    render_description,
    render_facts_table,
    render_header,
    render_image_urls,
)

log = logging.getLogger("sreality_hunt.cli")

# Directory of the skill (root of the package install). Used to find the
# saved-search example template for `search new`. The package is installed
# from `src/sreality_hunt/`, so the skill root is two parents up.
SKILL_DIR = Path(__file__).resolve().parent.parent.parent
EXAMPLE_YAML = SKILL_DIR / "examples" / "search.example.yaml"

VALID_REACTIONS = ("liked", "rejected", "saved", "visited")

# Exit code conventions. argparse already uses 2 for usage errors.
EXIT_OK = 0
EXIT_USER_ERROR = 2        # bad input the user can fix (missing search, bad YAML)
EXIT_LISTING_NOT_FOUND = 3
EXIT_SNAPSHOT_MISSING = 4
EXIT_API_FAILURE = 5
EXIT_INTERRUPT = 130


# ============================================================================
# main
# ============================================================================


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)

    handler = _DISPATCH.get(args.command)
    if handler is None:
        parser.print_help(sys.stderr)
        return EXIT_USER_ERROR

    try:
        return handler(args)
    except FileNotFoundError as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_USER_ERROR
    except ValidationError as e:
        # Pydantic dumps a multi-line error; keep it readable.
        print(f"error: invalid configuration\n{e}", file=sys.stderr)
        return EXIT_USER_ERROR
    except yaml.YAMLError as e:
        # Distinct from ValidationError: this is a YAML *parse* failure
        # (unclosed list, bad indent, etc.) before pydantic even sees the
        # data. Without this catch, it would bubble up as an unhandled
        # exception with a Python traceback.
        print(f"error: malformed YAML\n{e}", file=sys.stderr)
        return EXIT_USER_ERROR
    except ValueError as e:
        # e.g. invalid reaction, invalid limit, empty distilled prose
        print(f"error: {e}", file=sys.stderr)
        return EXIT_USER_ERROR
    except ListingNotFound as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_LISTING_NOT_FOUND
    except SnapshotMissing as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_SNAPSHOT_MISSING
    except SrealityError as e:
        print(f"error: sreality API failure: {e}", file=sys.stderr)
        return EXIT_API_FAILURE
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return EXIT_INTERRUPT


def _configure_logging(verbose: int) -> None:
    level = logging.WARNING
    if verbose >= 2:
        level = logging.DEBUG
    elif verbose >= 1:
        level = logging.INFO
    logging.basicConfig(
        level=level,
        format="%(name)s %(levelname)s: %(message)s",
        stream=sys.stderr,
    )


# ============================================================================
# Argparse
# ============================================================================


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="sreality-hunt",
        description="Apartment/house search assistant for sreality.cz.",
    )
    p.add_argument(
        "-v", "--verbose", action="count", default=0,
        help="increase log verbosity (-v INFO, -vv DEBUG; default WARNING)",
    )
    sub = p.add_subparsers(dest="command", required=True)

    # --- search namespace ---
    sp = sub.add_parser("search", help="manage saved searches")
    ss = sp.add_subparsers(dest="search_command", required=True)
    ss.add_parser("list", help="list saved searches")

    sp_new = ss.add_parser("new", help="create a new saved search from the example template")
    sp_new.add_argument("name", help="search name (becomes <name>.yaml)")
    sp_new.add_argument("--no-edit", action="store_true",
                        help="skip opening $EDITOR after creating the file")

    sp_show = ss.add_parser("show", help="print a saved search's YAML")
    sp_show.add_argument("name")

    sp_edit = ss.add_parser("edit", help="open a saved search in $EDITOR")
    sp_edit.add_argument("name")

    sp_val = ss.add_parser("validate",
                           help="check whether a saved search's YAML parses cleanly")
    sp_val.add_argument("name")

    # --- digest ---
    pd = sub.add_parser("digest", help="run a digest for a saved search")
    pd.add_argument("search", help="saved search name")
    pd.add_argument("--limit", type=int, default=None,
                    help="override filters.max_listings for this run")

    # --- evaluate ---
    pe = sub.add_parser("evaluate", help="evaluate a single listing")
    pe.add_argument("listing_id", type=int)
    pe.add_argument("--search", help="saved search name for context (must-haves + INPUTS appendix)")
    pe.add_argument("--from-snapshot", action="store_true",
                    help="use the latest DB snapshot instead of re-fetching detail")

    # --- fetch ---
    pf = sub.add_parser("fetch", help="dump structured facts for a listing (no checks, no pricing)")
    pf.add_argument("listing_id", type=int)
    pf.add_argument("--from-snapshot", action="store_true")

    # --- mark ---
    pm = sub.add_parser("mark", help="record a reaction on a listing")
    pm.add_argument("listing_id", type=int)
    pm.add_argument("reaction", choices=VALID_REACTIONS)
    pm.add_argument("--note", help="optional note about why")
    pm.add_argument("--search", help="search context hint (recorded with the reaction)")

    # --- history ---
    ph = sub.add_parser("history", help="browse recent reactions")
    ph.add_argument("--search", help="filter by search")
    ph.add_argument("--reaction", choices=VALID_REACTIONS, help="filter by reaction kind")
    ph.add_argument("--limit", type=int, default=20)

    # --- distill ---
    pdi = sub.add_parser("distill", help="distill past reactions into learned preferences")
    pdi.add_argument("search", help="saved search name")
    pdi.add_argument(
        "--apply", dest="apply_from", metavar="FILE",
        help="write distilled prose from FILE into the YAML's learned_preferences "
             "(use '-' for stdin)",
    )

    # --- compare ---
    pc = sub.add_parser("compare", help="evaluate multiple listings, output concatenated")
    pc.add_argument("listing_ids", nargs="+", type=int)
    pc.add_argument("--search")
    pc.add_argument("--from-snapshot", action="store_true")

    # --- open ---
    po = sub.add_parser("open", help="open a listing in the default browser")
    po.add_argument("listing_id", type=int)

    # --- db ---
    pdb = sub.add_parser("db", help="database management")
    pdbs = pdb.add_subparsers(dest="db_command", required=True)
    pdbs.add_parser("init", help="initialize the schema (idempotent)")

    return p


# ============================================================================
# Helpers
# ============================================================================


def _open_db() -> Any:
    """Open the canonical DB and apply any pending migrations."""
    return db.connect_and_init(db.db_path())


def _build_client() -> SrealityClient:
    return SrealityClient()


def _load_search(name: str) -> SavedSearch:
    path = models.search_path(name)
    if not path.exists():
        raise FileNotFoundError(
            f"saved search {name!r} not found at {path}; "
            f"run `sreality-hunt search new {name}` to create one"
        )
    return SavedSearch.load(path)


def _open_editor(path: Path) -> None:
    editor = os.environ.get("EDITOR", "vi")
    try:
        subprocess.call([editor, str(path)])
    except FileNotFoundError:
        print(
            f"warning: editor {editor!r} not found (set $EDITOR); skipping. "
            f"Edit {path} manually.",
            file=sys.stderr,
        )


# ============================================================================
# Command handlers
# ============================================================================


def _cmd_search(args: argparse.Namespace) -> int:
    sub = args.search_command
    if sub == "list":
        return _cmd_search_list()
    if sub == "new":
        return _cmd_search_new(args.name, no_edit=args.no_edit)
    if sub == "show":
        return _cmd_search_show(args.name)
    if sub == "edit":
        return _cmd_search_edit(args.name)
    if sub == "validate":
        return _cmd_search_validate(args.name)
    raise AssertionError(f"unhandled search subcommand {sub!r}")


def _cmd_search_list() -> int:
    names = models.list_search_names()
    sd = models.searches_dir()
    if not names:
        print(f"No saved searches in {sd}", file=sys.stderr)
        print("Create one with: sreality-hunt search new <name>", file=sys.stderr)
        return EXIT_OK

    print(f"Saved searches in `{sd}`:\n")
    with closing(_open_db()) as conn:
        for name in names:
            path = models.search_path(name)
            try:
                s = SavedSearch.load(path)
            except (ValidationError, yaml.YAMLError, OSError) as e:
                # YAMLError catches parse failures (unclosed list, bad
                # indent); ValidationError catches schema failures.
                # Either way, one bad file shouldn't kill the whole list.
                print(f"- **{name}**  _(ERROR loading: {e})_")
                continue
            seen_count = conn.execute(
                "SELECT COUNT(*) FROM seen WHERE search_name = ?", (name,),
            ).fetchone()[0]
            # Scope reactions via `seen` so the count matches what
            # `distill` / `build_fewshot_examples` actually use. Filtering
            # on `reactions.search_name` would undercount when the user
            # marked listings without `--search`.
            reaction_count = conn.execute(
                """
                SELECT COUNT(*) FROM reactions r
                JOIN seen sn ON sn.hash_id = r.hash_id AND sn.search_name = ?
                """,
                (name,),
            ).fetchone()[0]
            desc = s.description or "_(no description)_"
            cats = ", ".join(s.filters.category)
            print(f"- **{name}** — {desc}")
            print(
                f"  - filters: {cats}, "
                f"price≤{s.filters.price_max or '∞'}, area≥{s.filters.area_min or 0}m², "
                f"max_listings={s.filters.max_listings}"
            )
            print(f"  - {seen_count} listings seen, {reaction_count} reactions")
    return EXIT_OK


def _cmd_search_new(name: str, *, no_edit: bool) -> int:
    path = models.search_path(name)
    if path.exists():
        print(f"error: search {name!r} already exists at {path}", file=sys.stderr)
        return EXIT_USER_ERROR
    if not EXAMPLE_YAML.exists():
        print(f"error: example template missing at {EXAMPLE_YAML}", file=sys.stderr)
        return EXIT_USER_ERROR

    path.parent.mkdir(parents=True, exist_ok=True)
    # Read the example and swap the canonical `name:` line. Don't try to
    # round-trip via pydantic - it would strip the comments that make the
    # example useful as a template.
    template = EXAMPLE_YAML.read_text(encoding="utf-8")
    new_text = template.replace("name: family-house", f"name: {name}", 1)
    path.write_text(new_text, encoding="utf-8")
    print(f"Created {path}", file=sys.stderr)

    if not no_edit:
        _open_editor(path)
    return EXIT_OK


def _cmd_search_show(name: str) -> int:
    path = models.search_path(name)
    if not path.exists():
        raise FileNotFoundError(f"saved search {name!r} not found at {path}")
    print(path.read_text(encoding="utf-8"))
    return EXIT_OK


def _cmd_search_edit(name: str) -> int:
    path = models.search_path(name)
    if not path.exists():
        raise FileNotFoundError(
            f"saved search {name!r} not found; use `search new {name}` first"
        )
    _open_editor(path)
    return EXIT_OK


def _cmd_search_validate(name: str) -> int:
    """Confirm a saved-search YAML parses cleanly against the pydantic schema.

    Exits 0 with a one-line `valid` message on success, or 2 with the
    pydantic ValidationError on failure (re-raised so main's exception
    handler formats and exits consistently).
    """
    path = models.search_path(name)
    if not path.exists():
        raise FileNotFoundError(f"saved search {name!r} not found at {path}")
    # SavedSearch.load raises ValidationError (caught by main()) or
    # OSError (re-raised). Success means the YAML round-trips through
    # pydantic without errors.
    search = SavedSearch.load(path)
    n_filters = len(search.filters.category)
    n_checks = len(search.must_haves)
    print(
        f"`{name}` valid: {n_filters} categor{'y' if n_filters == 1 else 'ies'}, "
        f"{n_checks} must-have check{'' if n_checks == 1 else 's'}, "
        f"max_listings={search.filters.max_listings}"
    )
    return EXIT_OK


def _cmd_digest(args: argparse.Namespace) -> int:
    search = _load_search(args.search)
    with closing(_open_db()) as conn, _build_client() as client:
        pricing = ComparablePricingProvider(client)
        fewshot = build_fewshot_examples(conn, search.name)
        output, _counts = run_digest(
            search=search, db_conn=conn, client=client, pricing=pricing,
            max_listings=args.limit, fewshot_examples=fewshot,
        )
        print(output)
    return EXIT_OK


def _cmd_evaluate(args: argparse.Namespace) -> int:
    search = _load_search(args.search) if args.search else None
    with closing(_open_db()) as conn, _build_client() as client:
        pricing = ComparablePricingProvider(client)
        fewshot = (
            build_fewshot_examples(conn, search.name) if search else []
        )
        output = run_evaluate(
            hash_id=args.listing_id, db_conn=conn, client=client,
            search=search, pricing=pricing,
            from_snapshot=args.from_snapshot,
            fewshot_examples=fewshot,
        )
        print(output)
    return EXIT_OK


def _cmd_fetch(args: argparse.Namespace) -> int:
    """Header + facts table + photos + description. No checks, no pricing."""
    with closing(_open_db()) as conn, _build_client() as client:
        if args.from_snapshot:
            snap = db.get_latest_snapshot(conn, args.listing_id)
            if snap is None:
                raise SnapshotMissing(
                    f"no snapshot in DB for listing {args.listing_id}; "
                    f"run without --from-snapshot to fetch fresh"
                )
            detail = ListingDetail.model_validate(json.loads(snap["raw_json"]))
        else:
            detail, _sid = fetch_and_persist_detail(conn, client, args.listing_id)

        facts = extract_facts(detail)
        parts = [
            render_header(facts),
            "",
            "## Facts",
            "",
            render_facts_table(facts),
            "",
            "## Photos",
            "",
            render_image_urls(facts.image_urls),
            "",
            "## Description (Czech, original)",
            "",
            render_description(facts.description),
            "",
        ]
        print("\n".join(parts))
    return EXIT_OK


def _cmd_mark(args: argparse.Namespace) -> int:
    with closing(_open_db()) as conn:
        out = run_mark(
            db_conn=conn,
            hash_id=args.listing_id,
            reaction=args.reaction,
            note=args.note,
            search_name=args.search,
        )
        print(out)
    return EXIT_OK


def _cmd_history(args: argparse.Namespace) -> int:
    with closing(_open_db()) as conn:
        out = run_history(
            db_conn=conn,
            search_name=args.search,
            reaction_filter=args.reaction,
            limit=args.limit,
        )
        print(out)
    return EXIT_OK


def _cmd_distill(args: argparse.Namespace) -> int:
    search = _load_search(args.search)
    with closing(_open_db()) as conn:
        out = run_distill(
            db_conn=conn,
            search=search,
            apply_from=args.apply_from,
        )
        # Apply mode prints a status to stderr (so stdout stays a usable
        # data channel); read mode prints to stdout (it's the data).
        if args.apply_from is not None:
            print(out, file=sys.stderr)
        else:
            print(out)
    return EXIT_OK


def _cmd_compare(args: argparse.Namespace) -> int:
    search = _load_search(args.search) if args.search else None
    with closing(_open_db()) as conn, _build_client() as client:
        pricing = ComparablePricingProvider(client)
        fewshot = (
            build_fewshot_examples(conn, search.name) if search else []
        )
        ids = args.listing_ids
        print(f"# Compare: {' vs '.join(str(i) for i in ids)}\n")
        for i, hid in enumerate(ids):
            if i > 0:
                print("\n---\n")
            try:
                out = run_evaluate(
                    hash_id=hid, db_conn=conn, client=client,
                    search=search, pricing=pricing,
                    from_snapshot=args.from_snapshot,
                    fewshot_examples=fewshot,
                )
                print(out)
            except ListingNotFound as e:
                # Don't abort the whole compare on one bad listing.
                print(f"## {hid}\n\n_skipped: {e}_\n")
            except SnapshotMissing as e:
                print(f"## {hid}\n\n_skipped: {e}_\n")
    return EXIT_OK


def _cmd_open(args: argparse.Namespace) -> int:
    with closing(_open_db()) as conn:
        listing = db.get_listing(conn, args.listing_id)
        if listing is None:
            raise FileNotFoundError(
                f"listing {args.listing_id} not in DB; "
                f"run `sreality-hunt evaluate {args.listing_id}` first"
            )
        url = listing["url"]
        print(f"Opening {url}", file=sys.stderr)
        webbrowser.open(url)
    return EXIT_OK


def _cmd_db(args: argparse.Namespace) -> int:
    if args.db_command == "init":
        path = db.db_path()
        conn = db.connect_and_init(path)
        version = db.get_schema_version(conn)
        conn.close()
        print(f"DB initialized at {path} (schema v{version})", file=sys.stderr)
        return EXIT_OK
    raise AssertionError(f"unhandled db subcommand {args.db_command!r}")


# ============================================================================
# Dispatch table
# ============================================================================


_DISPATCH: dict[str, Any] = {
    "search":   _cmd_search,
    "digest":   _cmd_digest,
    "evaluate": _cmd_evaluate,
    "fetch":    _cmd_fetch,
    "mark":     _cmd_mark,
    "history":  _cmd_history,
    "distill":  _cmd_distill,
    "compare":  _cmd_compare,
    "open":     _cmd_open,
    "db":       _cmd_db,
}


if __name__ == "__main__":
    raise SystemExit(main())
