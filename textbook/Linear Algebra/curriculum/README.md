# linear-algebra learning objectives

Generated from learning-objectives.json. Revision: 89aadd8f3556e90fed0812891dd17918e25762db0461d5dcc3b12b41b561549f.

Operational statements are English; problems follow the book language.

## la-vector-space-axioms

Interpret vector-space axioms for concrete operations.

ベクトル空間の公理を具体的な演算に照らして説明できる

Status: active. Tasks: determine, prove.

- linear-algebra-ch1: 1.1. Vector space

- evidence: Identify the operations and quantifiers in each axiom and exhibit a violated axiom in a counterexample.

## la-subspace-criteria

Distinguish the three subspace conditions.

部分空間判定の三条件の意味を説明できる

Status: active. Tasks: determine, prove.

- linear-algebra-ch1: 1.2. Subspace
- linear-algebra-ch1: 2.1. A subset $U\subseteq V$ is a subspace of $V$ if and only if $U$ satisfies the following three conditions:

- evidence: Test zero membership and closure under addition and scalar multiplication separately using concrete subsets.

## la-subspace-decision

Determine whether a given set is a subspace with justification.

具体的な集合が部分空間か理由付きで判定できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch1: 1.2. Subspace
- linear-algebra-ch1: 2.1. A subset $U\subseteq V$ is a subspace of $V$ if and only if $U$ satisfies the following three conditions:

- evidence: Prove all three conditions when valid, or supply a concrete counterexample when invalid.

## la-sum-smallest

Prove the minimality of the sum of subspaces.

部分空間の和が各部分空間を含む最小の部分空間であることを示せる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch1: 2.2. For subspaces $V_1,\ldots,V_n$ of a vector space, their sum, defined below, is the smallest subspace that contains each $V_k$.

- evidence: Establish closure, inclusion of every summand, and inclusion in any common containing subspace.

## la-direct-sum

Determine whether a sum is direct using uniqueness or intersections.

分解の一意性または共通部分を使って直和を判定できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch1: 1.3. Direct sum
- linear-algebra-ch1: 2.3. Let $V_1,\ldots,V_m$ be subspaces of $V$. Then $V_1+\ldots+V_m$ is a direct sum if and only if the only way to write $0$ as a sum $v_1+\ldots+v_m$ is by taking all $v_k=0$.
- linear-algebra-ch1: 2.4. Suppose $U,W$ are subspaces of $V$. Then

- evidence: For two summands test that their intersection is zero and relate this to unique decomposition.

## la-direct-sum-conditions

Determine the limits of pairwise zero intersections for multiple summands.

三つ以上の部分空間で二つずつの共通部分が零でも直和とは限らないことを説明できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch1: 1.3. Direct sum
- linear-algebra-ch1: 2.3. Let $V_1,\ldots,V_m$ be subspaces of $V$. Then $V_1+\ldots+V_m$ is a direct sum if and only if the only way to write $0$ as a sum $v_1+\ldots+v_m$ is by taking all $v_k=0$.

- evidence: Construct a counterexample with a nontrivial decomposition of zero.

## la-span-membership

Determine membership in the span of a list.

ベクトルが与えられたリストの張る空間に属するか判定できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch2: 1.1. Span
- linear-algebra-ch2: 2.1. The span of a list is the smallest subspace containing every vector in that list.

- evidence: Supply coefficients of a linear combination or justify that no coefficients exist.

## la-linear-independence

Determine linear independence and construct dependence relations.

線形独立性を判定し、従属の場合は非自明な関係を示せる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch2: 1.4. Linear independence and dependence
- linear-algebra-ch2: 2.2. Suppose $v_1,\ldots,v_m$ is a linearly dependent list in $V$. Then there exists $k\in\{1,\ldots,m\}$ such that

- evidence: Analyze coefficients in a zero linear combination; do not conclude solely from the number of vectors.

## la-basis-coordinates

Determine whether a list is a basis and compute coordinates.

基底を判定し、その基底に関する座標を求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch2: 1.5. Basis
- linear-algebra-ch2: 2.4. A list $v_1,\ldots,v_n$ of vectors in $V$ is a basis if and only if every $v \in V$ can be written uniquely in the form

- evidence: Verify independence and spanning, and justify existence and uniqueness of coordinates.

## la-basis-extension

Construct a basis by reducing a spanning list or extending an independent list.

生成リストの縮約または独立リストの拡張により基底を構成できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch2: 2.5. Every finite-dimensional vector space has a basis.
- linear-algebra-ch2: 2.6. Every linearly independent set can be extended to a basis of a finite-dimensional vector space.

- evidence: Justify the resulting spanning and independence properties under finite dimensionality.

## la-dimension-sum

Compute dimensions of sums and intersections.

部分空間の和と共通部分の次元を関係付けて求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch2: 2.8. The length of any basis of a finite-dimensional vector space $V$ is always the same.
- linear-algebra-ch2: 2.9. If $V_1$ and $V_2$ are subspaces of a finite-dimensional vector space, then

- evidence: Apply the dimension formula with the intersection term correctly identified.

## la-complement-construction

Construct a complement to a subspace in finite dimensions.

有限次元空間で部分空間の補空間を構成できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch2: 2.6. Every linearly independent set can be extended to a basis of a finite-dimensional vector space.
- linear-algebra-ch2: 2.7. For every subspace $U$ of a finite-dimensional $V$, there is a subspace $W$ such that $U \oplus W=V$.

- evidence: Extend a basis and prove that the sum is the whole space with zero intersection.

## la-linear-map

Determine linearity and construct a map from basis values.

写像の線形性を判定し、基底上の値から写像を定められる

Status: active. Tasks: determine, prove.

- linear-algebra-ch3: 1.1. Linear maps and their algebraic operations
- linear-algebra-ch3: 2.1.1. Suppose $v_1,\ldots,v_n$ is a basis of $V$ and $w_1,\ldots,w_n \in W$. Then there exists a unique linear map $T:V \rightarrow W$ such that

- evidence: Check additivity and homogeneity and justify uniqueness of linear extension.

## la-kernel-range

Compute bases of kernels and ranges.

線形写像の核と像の基底を求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch3: 1.2. Kernel, range, nullity, and rank
- linear-algebra-ch3: 2.1.2. $T\in\mathcal{L}(V,W)$ is injective (one-to-one) if and only if $\ker(T)=\{0\}$.

- evidence: Solve the kernel equations and reduce image generators to an independent basis.

## la-rank-nullity

Determine injectivity and surjectivity using rank-nullity.

階数・退化次数定理を用いて単射・全射の可能性を判断できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch3: 2.1.3. Suppose $V$ is finite-dimensional and $T \in \mathcal{L}(V,W)$. Then
- linear-algebra-ch3: 2.1.4. Let $V,W$ be finite-dimensional vector spaces.
- linear-algebra-ch3: 2.1.10. Let $V,W$ be finite-dimensional vector spaces with the same dimension, and let $T\in\mathcal L(V,W)$. Then either injectivity or surjectivity implies invertibility.

- evidence: Distinguish domain and codomain dimensions and apply finite-dimensional hypotheses.

## la-matrix-composition

Compute matrices of maps and compositions in specified bases.

指定された基底で写像と合成写像を行列表示できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch3: 1.3. Let $V,W$ be finite-dimensional vector spaces with bases $\mathscr{B}=\{v_1,\ldots,v_n\}, \mathscr{C}=\{w_1,\ldots,w_m\}$, respectively. The matrix representation of a linear map $T\in \mathcal{L}(V,W)$ is defined as follows:
- linear-algebra-ch3: 2.1.6. Suppose $S \in \mathcal{L}(V,W)$ and $T \in \mathcal{L}(U,V)$ for finite-dimensional vector spaces $U,V,W$. Then $\mathcal{M}(ST)=\mathcal{M}(S)\mathcal{M}(T)$.
- linear-algebra-ch3: 2.1.13. Let $V,W$ be finite-dimensional vector spaces. Suppose $T \in \mathcal{L}(U,V), S \in \mathcal{L}(V,W)$, where $\mathscr{A}=\{u_1,\ldots,u_p\},\mathscr{B}=\{v_1,\ldots,v_n\},\mathscr{C}=\{w_1,\ldots,w_m\}$ are bases of $U,V,W$, respectively. Then

- evidence: Use image coordinates as columns and preserve composition order.

## la-change-basis

Compute changes of matrix representation under a change of basis.

基底変換による行列表現の変化を計算できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch3: 2.1.15. Let $V, W$ be finite-dimensional vector spaces. Let $\mathscr{A,A'}$ be bases of $V$ and $\mathscr{B,B'}$ be bases of $W$. Then

- evidence: Specify the coordinate transformation direction and use similarity for operators.

## la-quotient-map

Prove well-definedness of quotient elements and induced maps.

商空間の元と誘導写像の定義が代表元によらないことを示せる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch3: <b>1.6</b>. <span style="color: red">(Quotient Space)</span> Suppose $U$ is a subspace of $V$.  Then $V/U=\{v+U:v\in V\}$ is the set of all translates of $U$.
- linear-algebra-ch3: 1.7. <span style="color: red">(Quotient Map)</span> Suppose $U$ is a subspace of $V$. Then the linear map
- linear-algebra-ch3: 1.8. Suppose $T \in \mathcal{L}(V,W)$. Define
- linear-algebra-ch3: 2.2.3. Suppose $U$ is a subspace of $V$ and $v,w \in V$. Then
- linear-algebra-ch3: 2.2.5. Suppose $T \in \mathcal{L}(V,W)$. Then

- evidence: Use differences of representatives in the same coset to prove equality of images.

## la-quotient-dimension

Apply quotient dimensions and the first isomorphism theorem to a concrete map.

商空間の次元と第一同型定理を具体的な写像に適用できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch3: 2.2.4. Suppose $V$ is a finite-dimensional vector space and $U$ is a subspace of $V$. Then
- linear-algebra-ch3: 2.2.5. Suppose $T \in \mathcal{L}(V,W)$. Then

- evidence: Identify the kernel being quotiented and the range as the isomorphic image.

## la-dual-basis

Compute dual bases and matrices of dual maps.

指定された基底の双対基底と双対写像の行列を求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch3: 1.9. <span style="color: red">(Linear Functional)</span> Let $V$ be a vector space. Then the dual space $V'=\mathcal{L}(V,F)$ is the vector space of all linear functionals.
- linear-algebra-ch3: 1.10. <span style="color: red">(Dual Basis)</span> Suppose $\{v_1,\ldots,v_n\}$ is a basis of $V$. Then $\{\varphi_1,\ldots,\varphi_n\}$ is called the dual basis.
- linear-algebra-ch3: 1.11. <span style="color: red">(Dual Map)</span> Suppose $T\in\mathcal{L}(V,W)$. Then the dual map $T'\in\mathcal{L}(W',V')$ is defined for each $\varphi \in W',$
- linear-algebra-ch3: 2.3.1. Let $v_1,\ldots,v_n$ be a basis of $V$ and $\varphi_1,\ldots,\varphi_n$ be the dual basis. Then for each $v\in V$,
- linear-algebra-ch3: 2.3.6. Let $V,W$ be finite-dimensional vector spaces with dual spaces $V',W'$, and let $T\in\mathcal L(V,W)$. Let $\mathscr{B}=\{v_1,\ldots,v_n\},\mathscr{B'}=\{\varphi_1,\ldots,\varphi_n\}$ and $\mathscr{C}=\{w_1,\ldots,w_m\},\mathscr{C'}=\{\psi_1,\ldots,\psi_m\}$ be bases and dual bases of $V,W$, respectively. Then

- evidence: Verify evaluation identities and distinguish transpose from conjugate transpose.

## la-annihilator

Relate annihilators to kernels, ranges and dual maps.

零化空間を核・像および双対写像と関連付けられる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch3: 1.12. <span style="color: red">(Annihilator)</span> Suppose $U \subseteq V$. The annihilator of $U$, denoted by $U^0_{V}$ is defined by
- linear-algebra-ch3: 2.3.3. Suppose $U$ is a subspace of $V$. Then $U_V^0$ is a subspace of $V'$. If $V$ is finite-dimensional, $\dim(U_V^0)+\dim(U)=\dim(V)$.
- linear-algebra-ch3: 2.3.4. Let $T\in\mathcal{L}(V,W)$. Then $\ker(T')=(\operatorname{range}T)^0_W$.
- linear-algebra-ch3: 2.3.5. Let $V,W$ be finite-dimensional vector spaces and let $T\in \mathcal{L}(V,W)$. Then

- evidence: Identify the ambient dual space and establish equalities by inclusion or dimension.

## la-polynomial-division

Compute polynomial quotients and remainders.

多項式を除法定理に従って商と剰余に分解できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch4: 2.1.1. Suppose $m$ is a positive integer and $p\in\mathcal{P}_m(F)$ . Suppose $\lambda\in F$. Then $p(\lambda)=0$ if and only if there exists a polynomial $q\in\mathcal{P}_{m-1}(F)$ such that
- linear-algebra-ch4: 2.1.3. Suppose that $p,s\in\mathcal{P}(F)$, with $s \neq 0$. Then there exist unique polynomials $q,r\in\mathcal{P}(F)$ such that

- evidence: Check the polynomial identity and remainder degree, including zero remainders.

## la-root-bound

Prove polynomial identities using a bound on the number of roots.

根の個数の上限を使って多項式の同一性を示せる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch4: 1.1. A number $\lambda\in F$ is called a <b>zero</b> or <b>root</b> of a polynomial $p \in \mathcal{P}(F)$ if $p(\lambda)=0$.
- linear-algebra-ch4: 2.1.1. Suppose $m$ is a positive integer and $p\in\mathcal{P}_m(F)$ . Suppose $\lambda\in F$. Then $p(\lambda)=0$ if and only if there exists a polynomial $q\in\mathcal{P}_{m-1}(F)$ such that
- linear-algebra-ch4: 2.1.2. Suppose $m$ is a positive integer and $0\ne p\in\mathcal{P}_{m}(F)$. Then $p$ has at most $m$ distinct zeros in $F$.

- evidence: Compare the degree of the difference polynomial with the number of distinct roots.

## la-complex-factorization

Determine complex factorizations and conjugate root constraints of real polynomials.

複素数上の因数分解と実係数多項式の共役根を説明できる

Status: active. Tasks: determine, compute.

- linear-algebra-ch4: 2.1.4. Every nonconstant polynomial with complex coefficients has a zero in $\mathbb{C}$.
- linear-algebra-ch4: 2.1.5. If $p\in\mathcal{P}(\mathbb{C})$ is a nonconstant polynomial, then $p$ has a unique factorization (except for the order of the factors) of the form
- linear-algebra-ch4: 2.1.6. Suppose $p\in\mathcal{P}(\mathbb{C})$ is a polynomial with real coefficients and $p(\lambda)=0$. Then $\overline{\lambda}$ is also a zero of $p$.

- evidence: Count multiplicities and distinguish factorization over the real and complex fields; apply the fundamental theorem without demanding its proof from unavailable analysis.

## la-eigenpairs

Compute eigenvalues and eigenspaces from kernels.

固有値・固有空間を定義と核から求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch5: 1.1.3. Suppose $T \in \mathcal{L}(V)$. A number $\lambda \in F$ is called an <b>eigenvalue</b> of $T$ if there exists $v\in V$ such that $v \neq 0$ and $Tv=\lambda v$.
- linear-algebra-ch5: 1.1.4. Suppose $T \in \mathcal{L}(V)$ and $\lambda\in F$ is an eigenvalue of $T$. A vector $v\in V$ is called an <b>eigenvector</b> of $T$ corresponding to $\lambda$ if $v \neq 0$ and $Tv=\lambda v$.
- linear-algebra-ch5: 1.4.2. Suppose $T\in\mathcal{L}(V)$ and $\lambda\in F$. The eigenspace of $T$ corresponding to $\lambda$ is the subspace $E(\lambda,T)$ of $V$ defined by
- linear-algebra-ch5: 2.1.1. Suppose $V$ is finite-dimensional, $T\in \mathcal{L}(V)$, and $\lambda \in F$. Then the following statements are equivalent.

- evidence: Distinguish nonzero eigenvectors from eigenspaces that contain zero.

## la-invariant-subspace

Determine invariance and well-definedness of quotient operators.

部分空間の不変性と商作用素の定義可能性を確認できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch5: 1.1.2. Suppose $T \in \mathcal{L}(V)$. A subspace $U$ of $V$ is called <b>invariant</b> under $T$ if $Tu \in U$ for every $u \in U$.
- linear-algebra-ch5: 1.1.6. Suppose $V$ is finite-dimensional, $T\in\mathcal{L}(V)$, and $U$ is a subspace of $V$ invariant under $T$. Then the <b>quotient operator</b> $T/U\in\mathcal{L}(V/U)$ is defined by
- linear-algebra-ch5: 2.1.3. Suppose $T\in\mathcal{L}(V)$ and $p\in\mathcal{P}(F)$. Then $\ker(p(T))$ and $\operatorname{range}(p(T))$ are invariant under $T$.

- evidence: Check that images remain in the subspace and do not depend on representatives.

## la-minimal-polynomial

Compute and justify the minimal polynomial of a small operator.

低次元の作用素の最小多項式を求め、その最小性を説明できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch5: 1.1.5. Suppose $T \in \mathcal{L}(V)$ and $p\in \mathcal{P}(F)$ is a polynomial given by
- linear-algebra-ch5: 1.2.1. Suppose $V$ is finite-dimensional and $T\in\mathcal{L}(V)$. Then the minimal polynomial of $T$ is the unique monic polynomial $p\in\mathcal{P}(F)$ of smallest degree such that $p(T)=0$.
- linear-algebra-ch5: 2.2.2. Suppose $V$ is a finite-dimensional vector space and $T\in\mathcal{L}(V)$. Then there is a unique monic polynomial $p\in\mathcal{P}(F)$ of smallest degree such that $p(T)=0$. Furthermore, $\deg(p) \leq \dim(V)$.
- linear-algebra-ch5: 2.2.4. Suppose $V$ is a finite-dimensional vector space, $T\in\mathcal{L}(V)$, and $q\in\mathcal{P}(F)$. Then $q(T)=0$ if and only if $q$ is a polynomial multiple of the minimal polynomial of $T$.

- evidence: Verify annihilation and rule out lower degrees.

## la-triangularization

Relate triangularization to invariant flags and splitting of the minimal polynomial.

上三角表示と不変部分空間列・最小多項式の分解を結び付けられる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch5: 2.3.1. Suppose $V$ is a finite-dimensional vector space with a basis $\mathscr{B}=\{v_1,\ldots,v_n\}$ and $T\in\mathcal{L}(V)$. Then
- linear-algebra-ch5: 2.3.2. Suppose $V$ is a finite-dimensional vector space with a basis with respect to which $T$ has an upper triangular matrix with diagonal entries $\lambda_1,\ldots,\lambda_n$, then
- linear-algebra-ch5: 2.3.3. Suppose $V$ is finite-dimensional and $T\in\mathcal{L}(V)$. Then $T$ has an upper triangular matrix with respect to some basis of $V$ if and only if the minimal polynomial of $T$ equals $(z-\lambda_1)\cdots(z-\lambda_m)$ for some $\lambda_1,\ldots,\lambda_m\in F$, possibly repeated.

- evidence: Check splitting into linear factors over the specified field and interpret diagonal entries.

## la-diagonalizability

Determine diagonalizability from eigenspaces or minimal polynomials.

固有空間または最小多項式を使って対角化可能性を判定できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch5: 2.4.1. Suppose $T\in\mathcal{L}(V)$ and $\lambda_1,\ldots,\lambda_m$ are distinct eigenvalues of $T$. Then
- linear-algebra-ch5: 2.4.2. Suppose $V$ is a finite-dimensional vector space and $T\in\mathcal{L}(V)$. Let $\lambda_1,\ldots,\lambda_m$ denote the distinct eigenvalues of $T$. Then the following statements are equivalent.
- linear-algebra-ch5: 2.4.3. Suppose $V$ is a finite-dimensional vector space and $T\in\mathcal{L}(V)$. Then $T$ is diagonalizable if and only if the minimal polynomial of $T$ equals $(z-\lambda_1)\cdots(z-\lambda_m)$ for distinct $\lambda_1,\ldots,\lambda_m\in F$.

- evidence: Apply the dimension sum criterion or the distinct linear factor criterion correctly.

## la-commuting-operators

Determine conditions for common eigenvectors or simultaneous diagonalization.

可換作用素の共通固有ベクトルや同時対角化の条件を判断できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch5: 2.5.2. Suppose $S,T\in\mathcal{L}(V)$ commute and $\lambda\in F$. Then $E(\lambda,S)$ is invariant under $T$.
- linear-algebra-ch5: 2.5.3. Two diagonalizable operators on the same finite-dimensional vector space have diagonal matrices with respect to the same basis if and only if the two operators commute.
- linear-algebra-ch5: 2.5.4. Every pair of commuting operators on a finite-dimensional nonzero complex vector space has a common eigenvector.

- evidence: Check field and diagonalizability hypotheses rather than relying on commutativity alone.

## la-gershgorin

Compute Gershgorin disks and bound eigenvalue locations.

Gershgorin円板を求め、固有値の位置を制限できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch5: 1.4.3. <span style="color: red">(Gershgorin disks)</span> Suppose $T\in\mathcal{L}(V)$, $\mathscr{B}=\{v_1,\ldots,v_n\}$ is a basis of $V$, and $A=[T]_{\mathscr{B}}$. A <b>Gershgorin disk</b> of $T$ with respect to the basis $\mathscr{B}$ is a set of the form
- linear-algebra-ch5: 2.4.5. Suppose $V$ is a finite-dimensional vector space, $T\in\mathcal{L}(V)$ and $\mathscr{B}$ is a basis of $V$. Then each eigenvalue of $T$ is contained in at least one Gershgorin disk of $T$ with respect to the basis $\mathscr{B}$.

- evidence: Compute row centers and radii and distinguish bounds from exact eigenvalues.

## la-inner-product

Determine whether a form is an inner product under the source convention.

内積の条件と複素数上の共役の役割を説明できる

Status: active. Tasks: determine, prove.

- linear-algebra-ch6: 1.1.1. <span style="color: red">(Inner product)</span> An inner product on $V$ is a function that takes each ordered pair $(u,v)$ of elements of $V$ to a number $\langle u,v\rangle\in F$ and has the following properties.
- linear-algebra-ch6: 1.1.2. <span style="color: red">(Norm)</span> For $v\in V$, the norm of $v$ is defined by
- linear-algebra-ch6: 1.1.3. Two vectors $v,w \in V$ are called <b>orthogonal</b> if $\langle v,w \rangle=0$.

- evidence: Use linearity in the first variable, conjugate symmetry and positive definiteness.

## la-inner-product-inequalities

Apply Cauchy-Schwarz and determine equality cases.

Cauchy–Schwarzの不等式と等号条件を適用できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch6: 2.1.1. (Cauchy-Schwarz inequality) Suppose $u,v\in V$. Then
- linear-algebra-ch6: 2.1.2. <span style="color: red">(Triangle inequality)</span> Suppose $u,v\in V$. Then
- linear-algebra-ch6: 2.1.3. <span style="color: red">(Parallelogram equality)</span> Suppose $u,v\in V$. Then

- evidence: Relate norms and inner products and handle zero-vector equality cases.

## la-gram-schmidt

Construct an orthonormal basis using Gram-Schmidt.

Gram–Schmidt法で同じ部分空間を張る正規直交基底を作れる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch6: 2.2.3. Suppose $e_1,\ldots,e_n$ is an orthonormal basis of $V$ and $u,v\in V$. Then
- linear-algebra-ch6: 2.2.4. <span style="color: red">(Gram-Schmidt Procedure)</span> Suppose $v_1,\ldots,v_m$ is a list of linearly independent vectors in $V$. Let $f_1=v_1$. For $k=2,\ldots,m$, define

- evidence: Subtract projections, normalize and verify that each intermediate span is preserved.

## la-orthogonal-projection

Compute orthogonal complements and projections.

直交補空間と直交射影を求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch6: 1.3.1. If $U$ is a subset of $V$, then the orthogonal complement of $U$ is denoted by $U^{\perp}$, defined as follows.
- linear-algebra-ch6: 1.3.2. Let $V$ be an inner product space and let $U$ be a finite-dimensional subspace of $V$. Then the orthogonal projection $P_U\in\mathcal{L}(V)$ is defined as follows.
- linear-algebra-ch6: 2.3.1. Suppose $V$ is an inner product space and let $U$ be a finite-dimensional subspace of $V$. Then
- linear-algebra-ch6: 2.3.3. Suppose $U$ is a finite-dimensional subspace. Then $P_U$ has following properties.

- evidence: Verify orthogonality and target subspaces with the required finite-dimensional conditions.

## la-best-approximation

Prove uniqueness and minimality of orthogonal best approximation.

直交射影が一意な最良近似であることを説明できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch6: 2.3.5. Suppose $U$ is a finite-dimensional subspace of $V$, $v\in V$ and $u \in U$. Then

- evidence: Use orthogonal error decomposition and its equality case.

## la-riesz-representation

Construct the inner-product representative of a linear functional.

有限次元内積空間の線形汎関数を内積で表せる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch6: 2.2.6. <span style="color: red">(Riesz representation theorem)</span> Suppose $V$ is finite-dimensional inner product space and $\varphi$ is a linear functional on $V$. Then there exists a unique vector $v\in V$ such that
- linear-algebra-ch6: 2.3.4. Suppose $V$ is finite-dimensional. For each $v\in V$, define $\varphi_v\in V'$ by

- evidence: Compute the representing vector and verify conjugations and uniqueness in finite dimensions.

## la-pseudoinverse

Compute minimum-norm least-squares solutions using a pseudoinverse.

擬似逆を用いて最小ノルム最小二乗解を求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch6: 1.3.3. <span style="color: red">(Pseudoinverse)</span> Suppose $V,W$ are finite-dimensional inner product spaces and $T\in\mathcal{L}(V,W)$. The <b>pseudoinverse</b> $T^{\dagger}\in\mathcal{L}(W,V)$ of $T$ is a linear map defined by
- linear-algebra-ch6: 2.3.6. Let $T\in \mathcal{L}(V,W)$ between finite-dimensional inner product spaces. Then
- linear-algebra-ch6: 2.3.7. Let $T\in\mathcal{L}(V,W)$ between finite-dimensional inner product spaces and $w\in W$. Then

- evidence: Distinguish minimum residual from minimum solution norm and characterize kernel freedom.

## la-adjoint

Compute adjoints and relate their kernels and ranges.

随伴写像を求め、その核・像との関係を説明できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch7: 1.1.1. <span style="color: red">(Adjoint operator)</span> Suppose $T\in\mathcal{L}(V,W)$. The <b>adjoint</b> of $T$ is the function $T^*:W\rightarrow V$ such that
- linear-algebra-ch7: 1.1.2. <span style="color: red">(Conjugate transpose)</span> Let $A\in F^{m\times n}$. Then the <b>conjugate transpose</b> $A^*$ of $A$ is defined as follows.
- linear-algebra-ch7: 2.1.2. Suppose $V,W$ are finite-dimensional inner product spaces and let $T\in\mathcal{L}(V,W)$. Then
- linear-algebra-ch7: 2.1.3. Suppose $V,W$ are finite-dimensional inner product spaces and $T\in\mathcal{L}(V,W)$. Suppose $\beta=\{e_1,\ldots,e_n\},\gamma=\{f_1,\ldots,f_m\}$ are orthonormal bases of $V$ and $W$. Then

- evidence: Use conjugate transpose only in orthonormal bases and verify the relevant identities.

## la-operator-classes

Classify self-adjoint, normal and skew-adjoint operators.

自己随伴・正規・歪随伴作用素を区別できる

Status: active. Tasks: determine, prove.

- linear-algebra-ch7: 1.1.3. <span style="color: red">(Self-adjoint) </span>An operator $T\in\mathcal{L}(V)$ is called <b>self-adjoint</b> if $T=T^*$.
- linear-algebra-ch7: 1.1.4. <span style="color: red">(Normal)</span> An operator $T\in\mathcal{L}(V)$ is called <b>normal</b> if $TT^*=T^*T$.
- linear-algebra-ch7: 1.1.5. <span style="color: red">(Skew-adjoint)</span> An operator $T\in\mathcal{L}(V)$ is called skew-adjoint if $T^*=-T$.
- linear-algebra-ch7: 2.1.6. Suppose $T\in\mathcal{L}(V)$. Then

- evidence: Test adjoint identities and distinguish real and complex cases.

## la-spectral-theorem

Determine existence of orthonormal eigenbases using spectral theorems.

実・複素スペクトル定理を使い正規直交固有基底の存在を判断できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch7: 2.2.3. <span style="color: red">(Real spectral theorem)</span> Suppose $F=\mathbb{R}$ and $T\in\mathcal{L}(V)$. Then the following statements are equivalent.
- linear-algebra-ch7: 2.2.4. <span style="color: red">(Complex spectral theorem)</span> Suppose $F=\mathbb{C}$ and $T\in\mathcal{L}(V)$. Then the following statements are equivalent.

- evidence: Check self-adjointness over the reals or normality over the complexes.

## la-positive-square-root

Determine positivity and compute positive square roots.

正値性を判定し、正値作用素の正の平方根を求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch7: 1.3.1. <span style="color: red">(Positive operator)</span> An operator $T\in\mathcal{L}(V)$ is called positive if it is self-adjoint and
- linear-algebra-ch7: 1.3.2. An operator $R$ is a square root of an operator $T$ if $R^2=T$. For a positive operator, $\sqrt{T}$ denotes the unique positive square root of $T$.
- linear-algebra-ch7: 2.3.1. Let $V$ be a finite-dimensional inner product space and let $T \in \mathcal{L}(V)$. Then the following statements are equivalent.

- evidence: Verify self-adjointness, nonnegative eigenvalues and positivity of the square root.

## la-isometry-unitary

Determine isometry and unitary conditions.

等長写像とユニタリ作用素の条件を使い分けられる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch7: 1.4.1. <span style="color: red">(Isometry)</span> A linear map $S \in \mathcal{L}(V,W)$ is called an isometry if
- linear-algebra-ch7: 1.4.2. <span style="color: red">(Unitary)</span> An operator $S\in\mathcal{L}(V)$ is called unitary if $S$ is an invertible isometry.
- linear-algebra-ch7: 2.4.1. Suppose $V,W$ are finite-dimensional inner product spaces and let $S \in \mathcal{L}(V,W)$. Then the following statements are equivalent.
- linear-algebra-ch7: 2.4.2. Suppose $V$ is a finite-dimensional inner product space with an orthonormal basis $\beta=\{e_1,\ldots,e_n\}$ and let $S\in\mathcal{L}(V)$. Then the following statements are equivalent.

- evidence: Distinguish domain and codomain and avoid inferring invertibility from an unjustified one-sided identity.

## la-qr-cholesky

Compute QR or Cholesky factorizations under their hypotheses.

条件を満たす行列にQR分解またはCholesky分解を適用できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch7: 2.4.5. <span style="color: red">(QR factorization)</span> Suppose $A\in F^{n\times n}$ has linearly independent columns. Then there exist unique matrices $Q\text{(unitary)},R\text{(upper triangular with positive diagonal entries)} \in F^{n \times n}$ such that
- linear-algebra-ch7: 2.4.6. <span style="color: red">(Cholesky factorization)</span> Suppose $B$ is a positive definite matrix. Then there exists a unique upper-triangular matrix $R$ with only positive numbers on its diagonal such that

- evidence: Check independent columns or positive definiteness, verify the product and positive diagonal convention.

## la-svd

Construct a singular value decomposition and compute rank or pseudoinverse.

特異値分解を構成し、階数・擬似逆を読み取れる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch7: 1.5.1. <span style="color: red">(Singular value)</span> Suppose $T \in \mathcal{L}(V,W)$. The singular values of $T$ are nonnegative square roots of the eigenvalues of $T^*T$, listed in decreasing order, each included as many times as the dimension of the corresponding eigenspace of $T^*T$.
- linear-algebra-ch7: 2.5.1. Suppose $T \in \mathcal{L}(V,W)$. Then
- linear-algebra-ch7: 2.5.2. Suppose $T \in \mathcal{L}(V,W)$. Then
- linear-algebra-ch7: 2.5.3. <span style="color: red">(Singular value decomposition)</span> Suppose $T \in \mathcal{L}(V,W)$ and the positive singular values of $T$ are $s_1,\ldots,s_m$, counted with multiplicity ($m=\operatorname{rank}T$). Then there exist orthonormal lists $e_1,\ldots,e_m$ in $V$ and $f_1,\ldots,f_m$ in $W$ where
- linear-algebra-ch7: 2.5.4. <span style="color: red">(SVD for matrix)</span> Suppose $A \in F^{p \times n}$ of rank $m \geq 1$. Then there exist $B \in F^{p \times m}$ with orthonormal columns, a diagonal matrix with positive entries $D \in F^{m \times m}$, and $C \in F^{n \times m}$ with orthonormal columns such that

- evidence: Match orthonormal left and right vectors with positive singular values and handle zero values.

## la-low-rank-approximation

Compute operator norms and low-rank approximation errors.

特異値から作用素ノルムと低階数近似の誤差を求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch7: 1.6.1. <span style="color: red">(Norm of a linear map)</span> Suppose $T \in \mathcal{L}(V,W)$. Then the norm of $T$, denoted by $\|T\|$ is defined by
- linear-algebra-ch7: 2.6.1. Suppose $T \in \mathcal{L}(V,W)$. Let $s_1$ be the largest singular value of $T$. Then
- linear-algebra-ch7: 2.6.3. Suppose $T \in \mathcal{L}(V,W)$ and $s_1 \geq \cdots \geq s_m$ are the positive singular values of $T$ with corresponding orthonormal vectors $e_1,\ldots,e_m$ in $V$ and $f_1,\ldots,f_m$ in $W$. Suppose $1 \leq k < m$. Then

- evidence: Use the largest singular value for norm and the next omitted singular value for error.

## la-polar-decomposition

Construct polar decompositions in finite dimensions.

有限次元の作用素の極分解を構成できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch7: 2.6.4. Suppose $T \in \mathcal{L}(V)$. Then there exists a unitary operator $S \in \mathcal{L}(V)$ such that

- evidence: Verify the positive and unitary factors and their product.

## la-generalized-eigenvectors

Distinguish ordinary and generalized eigenvectors by concrete tests.

固有ベクトルと一般化固有ベクトルを区別できる

Status: active. Tasks: determine, prove.

- linear-algebra-ch8: 1.1.1. <span style="color: red">(Generalized eigenvector)</span> Suppose $T\in \mathcal{L}(V)$ and <b><span style="color: blue"><u>$\lambda$</u></span></b><b><span style="color: blue"><u> is an eigenvalue</u></span></b> of $T$. A vector $v \in V$ is called a generalized eigenvector of $T$ corresponding to $\lambda$ if $v \neq 0$ and
- linear-algebra-ch8: 1.2.1. <span style="color: red">(Generalized eigenspace)</span> Suppose $T \in \mathcal{L}(V), \dim(V)=n$ and $\lambda \in F$. The generalized eigenspace corresponding to $\lambda$ is defined by

- evidence: Check nonzero vectors and annihilation by appropriate powers of the shifted operator.

## la-nilpotence

Determine nilpotence and stabilization of kernels of powers.

冪零性と冪の核の安定化を調べられる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch8: 1.1.2. <span style="color: red">(Nilpotent)</span> An operator is called nilpotent if some power of it equals $0$.
- linear-algebra-ch8: 2.1.1. Suppose $T\in \mathcal{L}(V),\ \dim(V)=n$. Then
- linear-algebra-ch8: 2.1.4. Suppose $T \in \mathcal{L}(V),\ \dim(V)=n$. Then the following statements hold.
- linear-algebra-ch8: 2.1.5. Suppose $T \in \mathcal{L}(V),\ \dim(V)=n$. Then the following statements are equivalent.

- evidence: Compute powers and verify finite-dimensional and field hypotheses.

## la-generalized-decomposition

Decompose a complex finite-dimensional space into generalized eigenspaces.

複素有限次元空間を一般化固有空間の直和に分解できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch8: 2.2.1. Suppose $F=\mathbb{C}$ and $T\in \mathcal{L}(V)$. Let $\lambda_1,\ldots,\lambda_m$ be the distinct eigenvalues of $T$. Then
- linear-algebra-ch8: 2.2.3. Suppose $F = \mathbb{C}, T \in \mathcal{L}(V)$ and $\dim(V)=n$. Suppose $\beta = \{v_1,\ldots,v_n\}$ is a basis of $V$ such that $[T]_\beta$ is upper triangular. Then the number of times that each eigenvalue $\lambda$ appears on the diagonal element equals the multiplicity of it.
- linear-algebra-ch8: 2.2.4. Suppose $F = \mathbb{C}, T \in \mathcal{L}(V)$ and $\dim(V)=n$. Let $\lambda_1,\ldots,\lambda_m$ be the distinct eigenvalues of $T$ with multiplicities $d_1,\ldots,d_m$. There exists a basis $\beta$ where

- evidence: Verify each dimension and the direct sum dimension; distinguish ordinary eigenspaces.

## la-characteristic-polynomial

Compute characteristic polynomials from generalized eigenspace dimensions.

一般化固有空間の次元から特性多項式を求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch8: 1.2.2. <span style="color: red">(Multiplicity)</span> Suppose $T \in \mathcal{L}(V)$ and $\dim(V)=n$. The multiplicity of an eigenvalue $\lambda$ of $T$ is defined as the following:
- linear-algebra-ch8: 1.2.3. <span style="color: red">(Characteristic polynomial)</span> Suppose $T\in \mathcal{L}(V),\ \dim(V)=n$ and $F=\mathbb{C}$. Let $\lambda_1,\ldots,\lambda_m$ denote the distinct eigenvalues of $T$ with multiplicities $d_1,\ldots,d_m$. Then the following polynomial is called the characteristic polynomial of $T$.
- linear-algebra-ch8: 2.2.2. <span style="color: red">(Cayley-Hamilton theorem)</span> Suppose $F=\mathbb{C},\ T \in \mathcal{L}(V)$ and $q$ is the characteristic polynomial of $T$. Then $q(T)=0$.

- evidence: Count algebraic multiplicities and justify divisibility relationships with minimal polynomials.

## la-jordan-chains

Construct Jordan bases and blocks from generalized eigenvector chains.

一般化固有ベクトルの鎖からJordan基底とブロックを構成できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch8: 1.3.1. <span style="color: red">(Jordan basis)</span> Suppose $T\in\mathcal{L}(V)$. A basis $\beta$ of $V$ is called Jordan basis for $T$ if
- linear-algebra-ch8: 2.3.3. Suppose $T\in\mathcal{L}(V)$ is nilpotent. Then there is a basis of $V$ that is a Jordan basis.
- linear-algebra-ch8: 2.2.3. Suppose $F = \mathbb{C}, T \in \mathcal{L}(V)$ and $\dim(V)=n$. Suppose $\beta = \{v_1,\ldots,v_n\}$ is a basis of $V$ such that $[T]_\beta$ is upper triangular. Then the number of times that each eigenvalue $\lambda$ appears on the diagonal element equals the multiplicity of it.

- evidence: Verify chain relations and independence and relate kernel increments to block sizes.

## la-operator-square-root

Construct square roots of nilpotent or invertible complex operators when permitted.

冪零作用素や可逆複素作用素の平方根を構成する方針を説明できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch8: 2.3.1. Suppose $T\in\mathcal{L}(V)$ is nilpotent. Then $I+T$ has a square root.
- linear-algebra-ch8: 2.3.2. Suppose $V$ is a complex vector space and $T\in \mathcal{L}(V)$ is invertible. Then $T$ has a square root.

- evidence: Use a justified truncated polynomial or generalized eigenspace construction and verify its square; do not assert every nilpotent operator has a square root.

## la-trace

Verify operator claims using trace invariance and cyclicity.

トレースの基底不変性と巡回性を用いて作用素の主張を検証できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch8: 1.4.1. <span style="color: red">(Trace)</span> Suppose $A\in F^{n \times n}$. Then
- linear-algebra-ch8: 2.4.1. Suppose $T \in \mathcal{L}(V), \dim(V)=n$ and let $\beta,\gamma$ are bases of $V$. Then
- linear-algebra-ch8: 2.4.2. Suppose $F=\mathbb{C}$ and $T \in \mathcal{L}(V)$ with distinct eigenvalues $\lambda_1,\ldots,\lambda_m$, whose multiplicities are $d_1,\ldots,d_m$. Then
- linear-algebra-ch8: 2.4.3. The function $\operatorname{tr}:\mathcal{L}(V)\rightarrow F$ is a linear functional on $\mathcal{L}(V)$ such that
- linear-algebra-ch8: 2.4.4. There do not exist operators $S,T \in \mathcal{L}(V)$ such that $ST-TS=I$.

- evidence: State finite dimensionality and correctly handle eigenvalue multiplicities and commutator traces.

## la-bilinear-form

Compute matrices and basis changes for bilinear forms.

双線形形式の行列表現と基底変換を計算できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch9: 1.1.1. <span style="color: red">(Bilinear form)</span> A bilinear form is a function $\beta : V \times V \rightarrow F$ such that
- linear-algebra-ch9: 1.1.2. <span style="color: red">(Matrix representation of bilinear form)</span> Suppose $\beta$ is a bilinear form and let $\mathscr{B}=(e_1,\ldots,e_n)$ be an ordered basis of $V$. The matrix representation is defined as $M_{\mathscr{B}}(\beta)_{i,j}=\beta(e_i,e_j)$.
- linear-algebra-ch9: 2.1.1. Suppose $\beta$ is a bilinear form on $V$ and $T\in\mathcal{L}(V)$. Define bilinear forms $\alpha$ and $\gamma$ on $V$ by
- linear-algebra-ch9: 2.1.2. <span style="color: red">(Change of basis formula)</span> Suppose $\beta \in V^{(2)}$. Suppose $\mathscr{B}=\{e_1,\ldots,e_n\},\ \mathscr{C}=\{f_1,\ldots,f_n\}$ are bases of $V$. Let

- evidence: Verify bilinearity and distinguish congruence from similarity.

## la-quadratic-form

Represent and diagonalize real quadratic forms.

実二次形式を対称行列で表して対角化できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch9: 1.1.3. <span style="color: red">(Quadratic form)</span> For $\beta \in V^{(2)}$, define $q_\beta:V \rightarrow F$ by $q_\beta(v)=\beta(v,v)$. A function $q:V\to F$ is called a quadratic form on $V$ if there exists $\beta$ such that $q=q_\beta$.
- linear-algebra-ch9: 2.1.3. Suppose $\rho \in V^{(2)}$. Then the following statements are equivalent.
- linear-algebra-ch9: 2.1.4. Suppose $F=\mathbb{R}$ and $V$ is an inner product space. Let $\rho \in V_{\mathrm{sym}}^{(2)}$. Then there exists an orthonormal basis $\mathscr{B}$ where $M_{\mathscr{B}}(\rho)$ is diagonal.
- linear-algebra-ch9: 2.1.7. Suppose $q:V\to F$. Then $q$ is a quadratic form if and only if there exists a unique $\rho \in V_{\mathrm{sym}}^{(2)}$ such that $q = q_\rho$.
- linear-algebra-ch9: 2.1.8. Suppose $q$ is a quadratic form. Then

- evidence: Match cross-term coefficients correctly and verify the orthogonal basis change.

## la-alternating-forms

Determine alternating multilinear form values using permutations and dependence.

交代多重線形形式の値を置換と線形従属性から判断できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch9: 1.2.1. <span style="color: red">(Multilinear form)</span> An $m$-linear form on $V$ is a function $\alpha:V^m\to F$ that is linear in each variable while the other variables are fixed. The vector space of these forms is denoted by $V^{(m)}$.
- linear-algebra-ch9: 1.2.2. <span style="color: red">(Permutation)</span> Let $S_m$ denote the permutations of $\{1,\ldots,m\}$, and let $\sigma\in S_m$. Then
- linear-algebra-ch9: 2.2.1. Suppose $\alpha \in V_{\mathrm{alt}}^{(m)}$ and $v_1,\ldots,v_m$ are linearly dependent. Then
- linear-algebra-ch9: 2.2.2. Suppose $\alpha \in V_{\mathrm{alt}}^{(m)}$. For every $\sigma\in S_m$ and $v_1,\ldots,v_m\in V$,
- linear-algebra-ch9: 2.2.3. Let $n=\dim(V)$. Let $e_1,\ldots,e_n$ be a basis of $V$, $\varphi_1,\ldots,\varphi_n$ be the dual basis and $v_1,\ldots,v_n \in V$. Then

- evidence: Use separate linearity, permutation signs and vanishing on dependent inputs.

## la-determinant

Compute determinants and determine invertibility using determinant properties.

行列式の性質を用いて値と可逆性を判定できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch9: 1.3.1. <span style="color: red">(Determinant)</span> Let $n=\dim V\geq1$. For $\alpha\in V_{\mathrm{alt}}^{(n)}$ and $T\in\mathcal L(V)$, define
- linear-algebra-ch9: 2.3.1. The map $(v_1,\ldots,v_n) \mapsto \det(v_1,\ldots,v_n)$ is an alternating $n$-linear form on $F^n$.
- linear-algebra-ch9: 2.3.2. Let $A \in F^{n \times n}$. Then
- linear-algebra-ch9: 2.3.3. <span style="color: red">(Properties of determinants)</span> Suppose $S,T \in \mathcal{L}(V)$ and $A,B \in F^{n \times n}$.

- evidence: Choose appropriate alternation, multiplicativity or triangularity properties and verify signs.

## la-determinant-characteristic

Relate determinant characteristic polynomials to eigenvalues, trace and Cayley-Hamilton.

行列式による特性多項式を固有値・トレース・Cayley–Hamiltonと結び付けられる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch9: 1.3.2. <span style="color: red">(Characteristic polynomial)</span> Suppose $T \in \mathcal{L}(V)$. The polynomial defined as follows is called the characteristic polynomial.
- linear-algebra-ch9: 2.3.5. Suppose $F=\mathbb{C}$. Let $\lambda_1,\ldots,\lambda_m$ be distinct eigenvalues of $T \in \mathcal{L}(V)$ and let $d_1,\ldots,d_m$ denote their multiplicities. Then
- linear-algebra-ch9: 2.3.6. <span style="color: red">(Cayley-Hamilton theorem)</span> Let $q$ be the characteristic polynomial of $T \in \mathcal{L}(V)$. Then $q(T)=0$.
- linear-algebra-ch9: 2.3.7. The characteristic polynomial of $T \in \mathcal{L}(V)$ can be written as

- evidence: Use the det(zI-T) sign convention, check coefficients and substitute the operator.

## la-determinant-estimates

Apply Hadamard bounds or Vandermonde formulas to suitable matrices.

Hadamardの不等式またはVandermondeの公式を適切な行列に適用できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch9: 2.3.8. <span style="color: red">(Hadamard’s inequality)</span> Suppose $A\in F^{n \times n}$. Then
- linear-algebra-ch9: 2.3.9. <span style="color: red">(Vandermonde matrix)</span> Let $\beta_1,\ldots,\beta_n \in F$. Then

- evidence: Identify the matrix shape, column norms or parameters and distinguish estimates from exact values.

## la-tensor-basis

Compute bases and dimensions of finite-dimensional tensor products.

有限次元空間のテンソル積の基底と次元を求められる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch9: 1.4.1. Let $\mathcal{B}(V_1,\ldots,V_m)$ denote the set of all $m$-linear forms $\beta:V_1 \times \cdots \times V_m \rightarrow F$.
- linear-algebra-ch9: 1.4.2. <span style="color: red">(Tensor product)</span> Let $V_1 \otimes \cdots \otimes V_m:=\mathcal{B}(V_1',\ldots,V_m')$. The tensor product $v_1 \otimes \cdots \otimes v_m \in \mathcal{B}(V_1',\ldots,V_m')$ is defined as follows
- linear-algebra-ch9: 2.4.1. $(v_1,\ldots,v_m)\mapsto v_1 \otimes \cdots \otimes v_m$ is $m$-linear.
- linear-algebra-ch9: 2.4.2. Suppose $\beta_i =\{e_{i,1},\ldots,e_{i,n_i}\}$ is a linearly independent list in $V_i$ for each $i$, $i=1,\ldots,m$. Then

- evidence: Use multilinearity of pure tensors and match basis combinations with the dimension product.

## la-tensor-universal-property

Construct the linear map induced by a multilinear map on a tensor product.

多重線形写像に対応するテンソル積上の線形写像を構成できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch9: 2.4.3. Suppose $\Gamma : V_1 \times \cdots \times V_m \rightarrow U$ is an $m$-linear map. Then there exists a unique linear map $\hat{\Gamma}:V_1 \otimes \cdots \otimes V_m \rightarrow U$ such that

- evidence: Extend values on pure tensors linearly and justify existence and uniqueness.

## la-tensor-inner-product

Compute inner products, norms and orthonormal bases of tensor products.

テンソル積の内積・ノルム・正規直交基底を計算できる

Status: active. Tasks: prove, determine, compute, derive.

- linear-algebra-ch9: 1.4.3. <span style="color: red">(Inner product of tensor product)</span> Suppose $V_1,\ldots,V_m$ are inner product spaces. Then define the inner product on $V_1 \otimes \cdots \otimes V_m$ as the one that satisfies the following:
- linear-algebra-ch9: 2.4.4. Suppose $V$ and $W$ are inner product spaces, and let $e_1,\ldots,e_m$ and $f_1,\ldots,f_n$ be orthonormal bases of $V$ and $W$, respectively. Then

- evidence: Extend the product formula from pure tensors to sums and preserve the conjugation convention.
