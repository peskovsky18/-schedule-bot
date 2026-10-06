#!/usr/bin/env bash
#
# Публикует папку miniapp в ветку gh-pages для GitHub Pages.
#
#     ./deploy_pages.sh
#
# Почему ветка, а не GitHub Actions: у токена нет области workflow,
# поэтому файл .github/workflows/ создать нельзя. Ветку же пушить можно.
#
# Ветка собирается напрямую из объектов git (git commit-tree), поэтому
# рабочая копия не трогается: не нужно переключаться, ничего не теряется.
#
# Настроить нужно один раз: на GitHub → Settings → Pages → Source:
# «Deploy from a branch», ветка gh-pages, папка /(root).
#
# Заголовки кэша GitHub Pages не поддерживает. Это не страшно, потому что
# у скриптов и стилей стоит ?v=N, и номер поднимается при изменениях.

set -euo pipefail

BRANCH="${1:-gh-pages}"

if [ ! -d miniapp ]; then
  echo "Запускать из корня репозитория: папка miniapp не найдена" >&2
  exit 1
fi

if [ -n "$(git status --porcelain miniapp)" ]; then
  echo "В папке miniapp есть незакоммиченные изменения — сначала закоммитьте их." >&2
  git status --short miniapp >&2
  exit 1
fi

TREE=$(git rev-parse HEAD:miniapp)
SHORT=$(git rev-parse --short HEAD)
SUBJECT=$(git log -1 --pretty=%s)

COMMIT=$(git commit-tree "$TREE" -m "Мини-апп из $SHORT: $SUBJECT")

echo "Публикую $SHORT в ветку $BRANCH"
git push --force origin "$COMMIT:refs/heads/$BRANCH"

echo
echo "Готово. Если Pages уже включён, сайт обновится в течение минуты."
echo "Проверить: https://peskovsky18.github.io/-schedule-bot/"
