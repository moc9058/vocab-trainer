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

Use R or C as specified. Preserve finite-dimensional hypotheses when a theorem needs
them. Inner products in this textbook are linear in the first variable. Function
spaces may be infinite-dimensional; do not transfer finite-dimensional conclusions
to them without justification. Cite the supplied linear-algebra source headings;
do not invent a textbook citation for external background knowledge.

## Exercise examples

The following examples illustrate task shape and permitted background. They are not
additional linear-algebra theorems, mandatory templates or an extension of the selected
chapter scope. Do not copy them verbatim or treat a later-chapter example as permission
to use that chapter in an earlier test. Difficulty labels are design anchors relative
to this background, not empirically calibrated scores. Use comparable cognitive demand
when constructing a different question for the server-assigned objective and task kind.

### Foundation: prove a subspace property

Scope: chapter 1, la-subspace-decision. Task: prove. Difficulty: easy.

Let V = C^1(R, R) with the usual operations, and let U consist of all f in V satisfying
f'(t) + f(t) = 0 for every real t. Prove that U is a subspace of V by checking the zero
function and closure under addition and scalar multiplication.

Expected evidence: differentiate a linear combination and use the defining equation.
It is unnecessary to solve the ODE to prove closure. The method is explicitly supplied.

### Standard: compute the kernel and image of differentiation

Scope: chapter 3, la-kernel-range. Task: compute. Difficulty: standard.

Define D: P_3(R) -> P_2(R) by Dp = p'. Find a basis of ker D and a basis of range D.

Expected result: ker D = span(1), and range D = P_2(R), with basis (1, t, t^2).
Accept any equivalent bases. Require the kernel calculation and a justification that
all quadratics are attained, not only a list of differentiated monomials.

### Standard: determine invariance of a function subspace

Scope: chapter 5, la-invariant-subspace. Task: determine. Difficulty: standard.

On V = C^infinity(R, R), define Df = f'. Let U = span(exp(2t), exp(-t)). Determine
whether U is invariant under D and prove your conclusion.

Expected evidence: D exp(2t) = 2 exp(2t) and D exp(-t) = -exp(-t); linearity then
proves invariance for all of U. Infinite-dimensional V is acceptable here because
this argument does not use a finite-dimensional spectral theorem.

### Advanced: derive a differential-operator decomposition

Scope: chapter 5, la-eigenpairs and la-diagonalizability. Task: derive. Difficulty: hard.
The server must choose one primary objective and permit the others as prerequisites.

Let V be the real solution space of y'' - 3y' + 2y = 0 on R, and let D act by
differentiation. Derive the unique decomposition y = u + v where Du = u and Dv = 2v.
Find u and v in terms of y and y', and prove that your formulas have the stated properties.

Expected result: u = 2y - y' and v = y' - y. The given ODE shows u' = u and v' = 2v;
their sum is y, and the two eigenspaces intersect only in zero. The task requires
constructing and verifying the decomposition, not merely quoting an ODE solution formula.

### Standard: compute an orthogonal projection using integration

Scope: chapter 6, la-orthogonal-projection. Task: compute. Difficulty: standard.

Give P_2(R) the inner product <p,q> = integral from 0 to 1 of p(t)q(t) dt.
Find the orthogonal projection of t^2 onto span(1,t), and give the exact residual norm.

Expected result: the projection is t - 1/6, the residual is t^2 - t + 1/6,
and its norm is 1/sqrt(180). Check orthogonality to both 1 and t. Exact symbolic
forms are valid; decimal approximations are not required.

### Foundation: derive an integral functional's coordinate formula

Scope: chapter 3, la-dual-basis. Task: derive. Difficulty: easy.

For p(t) = a + bt + ct^2 in P_2(R), define phi(p) = integral from 0 to 1 of p(t) dt.
Derive phi's coordinates in the dual basis corresponding to (1,t,t^2), by evaluating
phi on the three basis vectors.

Expected result: phi = phi_1 + (1/2)phi_2 + (1/3)phi_3. The specified method supplies
scaffolding; do not confuse coordinates in the dual basis with polynomial coefficients.

## Assessment behavior

Require proofs, justified determinations, exact mathematical objects or derived
expressions. Do not use definition recall or explanation alone as the main task.
Use simple arithmetic when it is incidental to a linear-algebra objective. Accept
valid alternative proofs and equivalent symbolic expressions. Distinguish incorrect
linear-algebra reasoning from a minor calculus computation error in the rubric.
Do not make the calculus/ODE prerequisites more advanced to manufacture difficulty.
