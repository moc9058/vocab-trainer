# Linear algebra: assessment background and exercise reference

## Assumed knowledge

The learner may be assumed to know the standard Calculus and Differential Equations
material taught in the first two years of university. This background is explicitly
authorized for problem generation, independent solving, validation and grading, even
when it is not restated in the selected chapter Markdown or its objective prerequisites.
Do not require a separate explanation or introductory lesson before using this material.

Calculus background includes limits and continuity; derivatives and standard rules of
differentiation; elementary transcendental functions; definite and indefinite integrals;
the fundamental theorem of calculus; integration by substitution and by parts; standard
Taylor expansions; elementary sequences and series; partial derivatives, gradients,
Jacobians and basic multiple integration. Use familiar smooth functions, finite sums
and well-defined integrals. State domains and any smoothness or convergence assumptions
needed for the particular task. Do not assume advanced real analysis, measure theory,
distribution theory, functional analysis or unrestricted exchange of limits and integrals.

Differential Equations background includes first-order separable and linear ordinary
differential equations, initial-value problems, second-order linear equations with
constant coefficients, homogeneous and particular solutions, elementary exponential
and trigonometric solutions, and introductory finite systems of linear ODEs. State
initial conditions when needed. Do not assume partial differential equations, advanced
existence theory, nonlinear dynamical systems or numerical analysis without additional
explicit grounding. For systems, use only linear-algebra results permitted by the
selected scope: assumed ODE familiarity does not authorize later-chapter spectral
or Jordan theorems.

Elementary algebra, complex arithmetic, sets, functions and basic proof techniques
are also assumed. These permissions supplement the chapter-specific prerequisites;
they do not authorize arbitrary university mathematics. A narrower objective or task
constraint takes precedence over these general background permissions.

## Scope and conventions

Keep the selected linear-algebra objective essential to the task. Calculus and ODEs
may supply functions, differential or integral operators, concrete examples and familiar
solution formulas. Do not replace the assessment with a calculus-only or ODE-only exercise.
A task must still assess the assigned chapter rather than only its prerequisites.

Use $\mathbb{R}$ or $\mathbb{C}$ as specified. Preserve finite-dimensional hypotheses when a theorem needs
them. Inner products in this textbook are linear in the first variable. Function
spaces may be infinite-dimensional; do not transfer finite-dimensional conclusions
to them without justification. Cite the supplied linear-algebra source headings;
do not invent a textbook citation for external background knowledge.

## Preferred problem style

Make proof tasks the main style of this book's exercises, with particular emphasis
on proving properties of matrices. Prefer prompts beginning with "Prove that ...".
Favor structural statements about kernels, ranges, rank, similarity, eigenvalues,
diagonalizability, adjoints, positivity and determinants over routine numerical
matrix calculations. Choose the topic only when the selected chapter and assigned
objective permit it. In early chapters, use entrywise matrix examples that need no
later-chapter matrix theorem. Proof tasks may be easy, standard or hard; use the
versioned difficulty policy rather than equating proof with advanced difficulty.

Respect the server-assigned task kind. When the contract permits a choice, prefer
prove. For determine tasks, require a proof of the conclusion or a counterexample;
for compute and derive tasks, require a justified exact result or formula. Do not
silently change a compute/derive contract into a proof contract. A preference in this
reference does not override an explicit learner selection or the server's task plan.

Use LaTeX for mathematical notation in problems, example solutions and expected
proof evidence. Delimit inline mathematics with $...$ and displayed mathematics
with $$...$$. Use proper fractions, set notation, matrix environments and operators,
for example $\frac{1}{2\pi}$, $\ker A$, $\operatorname{rank}A$, and $A^{*}$.
Do not leave formulas as plain-text approximations such as "1/sqrt(180)" or "A^*A".

## Exercise examples

These are proof-oriented style and difficulty references, not mandatory templates
or additional source theorems. Construct different problems rather than copying
these examples. Respect the assigned objective, explicit prerequisites and selected
scope. In particular, do not import a later-chapter example into an earlier chapter.
The difficulty labels are design anchors and have not been empirically calibrated.
Expected evidence is private assessment context, not a hint to include by default
in the learner's problem statement.

### 1. Foundation: a subspace of matrices

Scope: chapter 1, la-subspace-decision. Task: prove. Difficulty: easy.

Let $n\geq 2$ and give $V=\mathbb{R}^{n\times n}$ entrywise addition and scalar
multiplication. Define

$$
U=\left\{A=(a_{ij})\in V:\sum_{j=1}^{n}a_{ij}=0
\text{ for every }i\in\{1,\ldots,n\}\right\}.
$$

Prove that $U$ is a subspace of $V$ by checking that it contains the zero matrix
and is closed under addition and scalar multiplication.

Expected evidence: for $A,B\in U$ and $\alpha,\beta\in\mathbb{R}$, each row sum of
$\alpha A+\beta B$ equals $\alpha\cdot0+\beta\cdot0=0$. No rank, determinant or
spectral result is needed.

### 2. Standard: rank of a matrix product

Scope: chapter 3, la-rank-nullity. Task: prove. Difficulty: standard.

Let $A\in\mathbb{F}^{m\times n}$ and $B\in\mathbb{F}^{n\times p}$, where
$\mathbb{F}\in\{\mathbb{R},\mathbb{C}\}$. Prove that

$$
\operatorname{rank}(AB)\leq
\min\{\operatorname{rank}A,\operatorname{rank}B\}.
$$

Expected evidence: use $\operatorname{range}(AB)\subseteq\operatorname{range}A$
and $\operatorname{range}(AB)=A(\operatorname{range}B)$. The image of a finite-dimensional
space has dimension at most that of its domain. No determinant or singular-value argument
is required. A proof via kernels and rank-nullity is also valid.

### 3. Standard: similarity preserves kernel dimension

Scope: chapter 3, la-change-basis. Task: prove. Difficulty: standard.

Let $A\in\mathbb{F}^{n\times n}$ and let $S\in\mathbb{F}^{n\times n}$ be invertible.
For every $\lambda\in\mathbb{F}$, prove that the map $v\mapsto S^{-1}v$ restricts
to an isomorphism

$$
\ker(A-\lambda I_n)\longrightarrow
\ker(S^{-1}AS-\lambda I_n).
$$

Deduce that these two kernels have equal dimension.

Expected evidence: verify
$(S^{-1}AS-\lambda I_n)S^{-1}v=S^{-1}(A-\lambda I_n)v$
and use the inverse map $w\mapsto Sw$. Here $\lambda$ is any scalar; the argument
does not require chapter 5's terminology or an eigenvalue theorem.

### 4. Advanced: an idempotent matrix is diagonalizable

Scope: chapter 5, la-diagonalizability. Task: prove. Difficulty: hard.

Let $P\in\mathbb{F}^{n\times n}$ satisfy $P^2=P$. Prove that

$$
\mathbb{F}^{n}=\ker P\oplus\operatorname{range}P.
$$

Then prove that $P$ is similar to

$$
\begin{pmatrix}
I_r&0\\
0&0_{n-r}
\end{pmatrix},\qquad r=\operatorname{rank}P,
$$

and hence is diagonalizable. Include the cases $r=0$ and $r=n$.

Expected evidence: use $x=(x-Px)+Px$ and prove that the intersection is zero.
On the range, $P$ acts as the identity; on the kernel, it acts as zero. Choose
bases of the two summands in the stated block order. The task requires constructing
the decomposition and basis, not only quoting a diagonalizability criterion.

### 5. Standard: a polynomial inverse of a nilpotent matrix perturbation

Scope: chapter 5, la-minimal-polynomial. Task: prove. Difficulty: standard.

Let $N\in\mathbb{F}^{n\times n}$ satisfy $N^k=0$ for a positive integer $k$.
Prove that $I_n-N$ is invertible and that

$$
(I_n-N)^{-1}=I_n+N+N^2+\cdots+N^{k-1}.
$$

Expected evidence: multiply the finite polynomial on both sides of $I_n-N$ and
obtain $I_n-N^k=I_n$. This is a finite identity, not a convergence argument or an
application of chapter 8's general Jordan theory.

### 6. Standard: a Gram matrix has the same kernel and rank

Scope: chapter 7, la-adjoint. Task: prove. Difficulty: standard.

Let $A\in\mathbb{C}^{m\times n}$ and let $A^{*}$ denote its conjugate transpose.
Prove that $A^{*}A$ is positive semidefinite and that

$$
\ker(A^{*}A)=\ker A,
\qquad
\operatorname{rank}(A^{*}A)=\operatorname{rank}A.
$$

Expected evidence: verify $(A^{*}A)^{*}=A^{*}A$ and
$\langle A^{*}Ax,x\rangle=\|Ax\|^2\geq0$. If $A^{*}Ax=0$, then $Ax=0$;
the reverse inclusion is immediate. Apply rank-nullity with the common domain
$\mathbb{C}^{n}$. Respect the textbook's first-variable-linear inner product convention.

### 7. Advanced: a product of Hermitian matrices

Scope: chapter 7, la-operator-classes. Task: prove. Difficulty: hard.

Let $A,B\in\mathbb{C}^{n\times n}$ be Hermitian. Prove that $AB$ is Hermitian
if and only if $AB=BA$. Prove further that if $A$ and $B$ are positive semidefinite
and commute, then $AB$ is positive semidefinite.

Expected evidence: use $(AB)^{*}=BA$ for the equivalence. For the second assertion,
use simultaneous unitary diagonalization of commuting Hermitian matrices; the
diagonal entries of the product are products of nonnegative real numbers. Permit
this extension only when the relevant spectral and simultaneous-diagonalization
results are in the allowed prerequisites. Do not assume that arbitrary products
of positive semidefinite matrices are positive semidefinite.

### 8. Advanced: a rank-one determinant identity

Scope: chapter 9, la-determinant. Task: prove. Difficulty: hard.

Let $u,v\in\mathbb{F}^{n}$ and let $v^{\mathsf T}$ denote transpose, without
complex conjugation. Prove that

$$
\det(I_n+uv^{\mathsf T})=1+v^{\mathsf T}u.
$$

Expected evidence: column $j$ is $e_j+v_j u$. Expand by multilinearity in the columns.
Terms using $u$ in two or more columns vanish by alternation. The term using no
$u$ equals $1$; the term replacing only column $j$ contributes $v_j u_j$.
This proves the formula over both $\mathbb{R}$ and $\mathbb{C}$ without replacing
transpose by adjoint or assuming the rank-one matrix is diagonalizable.

### 9. Standard: an ODE solution space gives a linear-algebra proof

Scope: chapter 1, la-subspace-decision. Task: prove. Difficulty: standard.

In $V=C^2(\mathbb{R},\mathbb{R})$, let

$$
W=\{f\in V:f''(t)-3f'(t)+2f(t)=0\text{ for all }t\in\mathbb{R}\}.
$$

Prove that $W$ is a subspace of $V$. Prove also that the set

$$
Z=\{f\in V:f''(t)-3f'(t)+2f(t)=1\text{ for all }t\in\mathbb{R}\}
$$

is not a subspace of $V$.

Expected evidence: prove closure of the homogeneous solution space using linearity
of differentiation. The zero function is not in $Z$. Solving either ODE is unnecessary.
Calculus and ODEs provide permitted background; subspace reasoning remains the target.

## Assessment behavior

Prioritize proofs of matrix properties when compatible with the assigned objective
and task kind. Ask for mathematical arguments rather than a verbal description of
a definition, a theorem recital or an unexplained numerical answer. Accept valid
alternative proofs and equivalent LaTeX expressions. Use simple arithmetic when
incidental. Distinguish incorrect structural reasoning from a minor computation error.
Do not manufacture difficulty by raising the Calculus or Differential Equations level.
