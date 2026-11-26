# Règles de grille pour un agent

Les règles que l'auteur des évaluations, le concepteur et le juge suivent. Modifiez-les pour qu'elles correspondent à la façon dont votre équipe juge un agent. Les cas d'un agent sont le fichier Markdown `evals/<agent>/cases.md` du projet, et modifier ce fichier modifie la définition du travail terminé. `evals/<agent>/run.sh` les exécute ; chaque réponse est gardée dans `/out/cases/<agent>/<id du cas>.md`.

## Un point de la grille

- Il est vrai ou faux, jamais « bon » ou « approprié ». « La réponse nomme le fichier et la ligne » est un point ; « la réponse est utile » n'en est pas un.
- Il porte sur ce qui s'observe : la réponse finale, un outil appelé ou non, un fichier écrit. Jamais sur ce que l'agent « voulait dire ».
- De deux à cinq points par cas. Plus de cinq, c'est deux cas.

## Un bon cas

- Une entrée, exactement comme l'agent la reçoit, avec le contexte qu'il aurait.
- Un comportement attendu, en une phrase.
- Une raison d'exister : un échec réel, un risque, ou le travail ordinaire. Un cas sans raison est écarté.
- Au moins un cas du fichier où le bon comportement est de s'arrêter, de demander à une personne ou de dire qu'il ne peut pas.

## Ce qui compte comme preuve

La réponse qu'une exécution a gardée pour le cas, un appel d'outil enregistré dans la tâche, ou une ligne d'un fichier. « Cela fonctionnerait » n'est pas une preuve, pas plus que ce que le prompt dit que l'agent devrait faire. Un point que l'exécution ne peut pas montrer compte comme non atteint. Le comportement attendu et la grille ne sont jamais envoyés à l'agent testé.

## La note

La note est la part des points atteints et prouvés. Un fichier qui contient un cas sans point, ou sans cas de refus, est rejeté quelle que soit la note. L'agent n'a pas plus d'outils ni de niveau `native` plus élevé que ce que son prompt utilise.
