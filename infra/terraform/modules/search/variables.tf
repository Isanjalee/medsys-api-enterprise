variable "name_prefix" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "search_security_group_id" {
  type = string
}

variable "instance_type" {
  type = string
}

variable "instance_count" {
  type = number
}

variable "ebs_volume_size" {
  type = number
}

variable "tags" {
  type = map(string)
}
