export interface Document {
  meta: {
    type: string
  }
  id: string
}

export interface DocumentCollection {
  rows: Document[]
}

export interface DocumentRef {
  type: string
  id: string
}
