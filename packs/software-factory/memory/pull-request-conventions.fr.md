# Conventions des pull requests

Ce sont les valeurs par défaut de l'espace de travail. Les règles propres à un projet (`CLAUDE.md`, `AGENTS.md`, un guide de contribution ou un modèle de pull request) l'emportent dès qu'elles diffèrent.

## Une pull request, un objectif

- Une pull request fait une seule chose : un correctif, ou une fonctionnalité. Un refactoring nécessaire au changement en fait partie ; un nettoyage sans rapport, non.
- Gardez-la assez petite pour être relue en une seule fois. Si le diff dépasse environ 400 lignes modifiées, expliquez dans la description pourquoi il n'a pas pu être découpé.
- Pas de reformatage de lignes que le changement n'a pas touchées, et pas de fichiers générés, sauf si le projet les versionne.

## Titre

Une seule ligne, 72 caractères au plus, qui dit ce que fait le changement, en commençant par un verbe : "Rejeter les invitations expirées à la connexion". Pas "Corriger un bug", ni le seul numéro de l'issue. Suivez le style de préfixe du projet (comme `fix:` ou `feat:`) quand son historique en montre un.

## Description

En Markdown, dans cet ordre :

1. **Quoi** : le comportement qui change, en deux à quatre phrases, avec des mots que comprend un utilisateur du code.
2. **Pourquoi** : l'issue ou l'objectif auquel elle répond, avec un lien ou une référence s'il y en a un.
3. **Comment cela a été vérifié** : les commandes exactes exécutées et leur résultat, et le test ajouté. Uniquement ce qui a réellement été exécuté.
4. **Notes pour le relecteur** : les risques, les décisions qui auraient pu aller dans l'autre sens, les suites laissées de côté volontairement.

## Ce qu'une pull request ne contient jamais

- Un secret, un jeton, un mot de passe ou des données d'un vrai client, que ce soit dans le code, les tests, les jeux de données ou la description.
- Un test désactivé ou supprimé sans explication dans la description.
- Une nouvelle dépendance sans une phrase qui dit pourquoi elle est nécessaire.
- Des modifications des fichiers d'intégration continue, de déploiement ou de permissions, sauf si c'était précisément l'objectif.

## Comment les pull requests sont ouvertes ici

- Les agents laissent les changements dans la copie de travail. Ils ne font jamais de commit, de push ni de fusion.
- Une pull request s'ouvre uniquement avec l'outil `git.open-pr`, à partir du diff de la copie de travail, sur une branche nommée par Brain. Une personne approuve l'appel avant qu'il n'ait lieu.
- Aucun agent ne fusionne quoi que ce soit. Une personne fusionne une fois que les vérifications propres au projet sont passées.
