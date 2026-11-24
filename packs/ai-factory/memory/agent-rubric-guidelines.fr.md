# Règles de grille pour un agent

Les règles que l'auteur des évaluations, le concepteur et le juge suivent. Modifiez-les pour qu'elles correspondent à la façon dont votre équipe juge un agent. Brain n'a pas de registre de scénarios : les cas d'un agent sont le fichier Markdown `evals/<agent>/cases.md` du projet, et modifier ce fichier modifie la définition du travail terminé.

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

Un appel d'outil enregistré dans la tâche, une ligne d'un fichier, ou le texte de la réponse. « Cela fonctionnerait » n'est pas une preuve. Un point que le texte du prompt ne tranche pas compte comme non atteint.

## La note

La note est la part des points atteints et prouvés. Un fichier qui contient un cas sans point, ou sans cas de refus, est rejeté quelle que soit la note. L'agent n'a pas plus d'outils ni de niveau `native` plus élevé que ce que son prompt utilise.
