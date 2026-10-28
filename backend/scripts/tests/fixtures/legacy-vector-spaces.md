# 1. Vector Spaces

Source: https://www.notion.so/40669428c861814bb362d6a492324792

> Throughout this chapter, $F=\mathbb R$ or $\mathbb C$, and all subspaces use the same scalar field.

## 1. Definitions

### 1.1. Vector space

- A vector space over a field $F$ is a set $V$ along with an addition on $V$ and a scalar multiplication over $F$ such that the following properties hold.
  - Commutativity: $u+v=v+u$.

  - Associativity: $(u+v)+w=u+(v+w)$ and $(ab)v=a(bv)$.

  - Additive identity: there exists $0\in V$ such that $v+0=v$.

  - Additive inverses: for each $v\in V$, there exists $-v\in V$ with $v+(-v)=0$.

  - Multiplicative identity: $1v=v$.

  - Distributivity: $a(u+v)=au+av$ and $(a+b)v=av+bv$.

These identities hold for all $u,v,w\in V$ and $a,b\in F$.

#### Properties

- A vector space has a unique additive identity ($0$).

- Every element ($x$) in a vector space has a unique additive inverse ($-x$).

- $0v=0$ and $a0=0$ for all $v\in V$ and $a\in F$.

- $(-1)v=-v\text{ for every }v\in V$.

### 1.2. Subspace

- A subset $U$ of a vector space $V$ is a subspace if $U$ is itself a vector space with the same additive identity, addition, and scalar multiplication as on $V$.

### 1.3. Direct sum

- Let $V_1,\ldots,V_n$ be subspaces of a vector space. The sum $V=V_1 + \ldots + V_n$ is called a direct sum if each element of $V$ can be written in only one way as a sum $v_1 + \ldots + v_n$, where each $v_k\in V_k$.

- $V_1\oplus V_2\oplus \ldots\oplus V_n$ denotes the direct sum.

## 2. Theorems

### 2.1. A subset $U\subseteq V$ is a subspace of $V$ if and only if $U$ satisfies the following three conditions:

- $0\in U$

- $u,w\in U \text{ implies }u+w\in U$

- $a\in F\text{ and }u\in U\text{ implies }au\in U$


## End of legacy fixture
